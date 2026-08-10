import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Parser } from "htmlparser2";
import TurndownService from "turndown";
import { Type } from "typebox";
import { errorResult, textResult } from "../results.ts";
import { saveWikiEntry, slugifyUrl, type WikiSaveResult, wikiRoot } from "../wiki.ts";

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;
const MIN_TIMEOUT_SECONDS = 1;
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

const webFetchParams = Type.Object({
  url: Type.String({ description: "The URL to fetch content from" }),
  format: Type.Optional(
    Type.Union([Type.Literal("markdown"), Type.Literal("text")], {
      description: "The format to return the content in (markdown or text). Defaults to markdown.",
      default: "markdown",
    }),
  ),
  timeout: Type.Optional(Type.Number({ description: "Optional timeout in seconds (maximum 120)" })),
});

type WebFetchParams = {
  url: string;
  format?: "markdown" | "text";
  timeout?: number;
};

export interface WebFetchDetails {
  wiki?: {
    saved: boolean;
    topic: string;
    pages: string[];
  };
  wikiSaveError?: string;
}

export interface WebFetchExecutionOptions {
  wikiRoot?: string;
  now?: () => Date;
}

/** Register the HTTP `web_fetch` tool; successful research is saved to the local wiki. */
export function registerWebFetchTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "web_fetch",
    label: "Web fetch",
    description:
      "Fetches content from a specified URL and converts HTML to markdown or text. Use this tool to retrieve and analyze web content. Search local LLM wikis first with llm_wikis_search when possible; successful results from this tool are automatically saved to the local wiki for reuse. The URL must be a fully-formed HTTP or HTTPS URL.",
    parameters: webFetchParams,
    async execute(
      _toolCallId: string,
      params: WebFetchParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<WebFetchDetails>> {
      try {
        return await executeWebFetch(params, signal);
      } catch (error) {
        return errorResult(toErrorMessage(error), {});
      }
    },
  });
}

export async function executeWebFetch(
  params: WebFetchParams,
  signal?: AbortSignal,
  options?: WebFetchExecutionOptions,
): Promise<AgentToolResult<WebFetchDetails>> {
  const url = normalizeHttpUrl(params.url);
  const format = params.format ?? "markdown";
  const timeoutSeconds = normalizeTimeout(params.timeout);
  const timeoutSignal = AbortSignal.timeout(timeoutSeconds * 1000);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const browserHeaders = {
    "User-Agent": BROWSER_USER_AGENT,
    Accept: acceptHeader(format),
    "Accept-Language": "en-US,en;q=0.9",
  };
  let response = await fetch(url, {
    method: "GET",
    headers: browserHeaders,
    redirect: "follow",
    signal: requestSignal,
  });

  // Retry exactly once with a plain user agent when Cloudflare bot detection
  // challenges the browser-like fingerprint; the retry stays inside the same
  // total timeout budget because the combined signal is reused.
  if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
    await response.body?.cancel().catch(() => {});
    response = await fetch(url, {
      method: "GET",
      headers: { ...browserHeaders, "User-Agent": "opencode" },
      redirect: "follow",
      signal: requestSignal,
    });
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText || "Request failed"}`);
  }

  const body = await readResponseBody(response, MAX_RESPONSE_SIZE);
  const contentType = response.headers.get("content-type") ?? "";
  const mime = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const title = `${url} (${contentType})`;

  if (isRasterImageMime(mime)) {
    if (body.byteLength === 0) {
      return {
        content: [
          { type: "text" as const, text: "Image fetched successfully" },
          { type: "image" as const, data: "", mimeType: mime },
        ],
        details: {},
      };
    }
    const details: WebFetchDetails = {};
    const saved = await persistFetchResult(url, title, "Image fetched successfully", "image", options);
    details.wiki = toWikiDetails(saved);
    if (saved.error) details.wikiSaveError = saved.error;
    return {
      content: [
        { type: "text" as const, text: "Image fetched successfully" },
        { type: "image" as const, data: Buffer.from(body).toString("base64"), mimeType: mime },
      ],
      details,
    };
  }

  if (!isTextContentType(mime)) {
    return textResult(`Unsupported binary content-type: ${mime || "unknown"}`, {});
  }

  const content = decodeBody(body, contentType);
  if (isHtmlContentType(mime)) {
    const output = format === "text" ? extractTextFromHTML(content) : convertHTMLToMarkdown(content);
    if (!output.trim()) return textResult(`${title}\n\n${output}`, {});
    const details: WebFetchDetails = {};
    const saved = await persistFetchResult(url, title, output, format, options);
    details.wiki = toWikiDetails(saved);
    if (saved.error) details.wikiSaveError = saved.error;
    return textResult(`${title}\n\n${output}`, details);
  }
  if (!content.trim()) return textResult(`${title}\n\n${content}`, {});
  const details: WebFetchDetails = {};
  const saved = await persistFetchResult(url, title, content, format, options);
  details.wiki = toWikiDetails(saved);
  if (saved.error) details.wikiSaveError = saved.error;
  return textResult(`${title}\n\n${content}`, details);
}

function normalizeHttpUrl(value: string): string {
  const url = value.trim();
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error("URL must start with http:// or https://");
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("URL must start with http:// or https://");
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof Error && error.message === "URL must start with http:// or https://") throw error;
    throw new Error("Invalid URL");
  }
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_SECONDS;
  return Math.min(Math.max(value, MIN_TIMEOUT_SECONDS), MAX_TIMEOUT_SECONDS);
}

function acceptHeader(format: "markdown" | "text"): string {
  if (format === "text") {
    return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
  }
  return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
}

async function readResponseBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  const parsedLength = declaredLength === null ? undefined : Number.parseInt(declaredLength, 10);
  if (parsedLength !== undefined && Number.isSafeInteger(parsedLength) && parsedLength > maximumBytes) {
    throw new Error("Response too large (exceeds 5MB limit)");
  }

  if (!response.body) {
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > maximumBytes) throw new Error("Response too large (exceeds 5MB limit)");
    return body;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel("Response too large (exceeds 5MB limit)");
        throw new Error("Response too large (exceeds 5MB limit)");
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // The stream may already be closed by the transport.
    }
    throw error;
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function decodeBody(body: Uint8Array, contentType: string): string {
  const charset = /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)?.[1] ??
    /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)?.[2];
  if (charset) {
    try {
      return new TextDecoder(charset).decode(body);
    } catch {
      // Unsupported declarations use the contract's UTF-8 fallback.
    }
  }
  return new TextDecoder("utf-8").decode(body);
}

function isHtmlContentType(mime: string): boolean {
  return mime === "text/html" || mime === "application/xhtml+xml";
}

function isRasterImageMime(mime: string): boolean {
  return mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet";
}

function isTextContentType(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/xhtml+xml" ||
    mime === "application/json" ||
    mime.endsWith("+json") ||
    mime === "application/xml" ||
    mime.endsWith("+xml") ||
    mime === "application/javascript" ||
    mime === "application/ld+json" ||
    mime === "image/svg+xml"
  );
}

export function extractTextFromHTML(html: string): string {
  let text = "";
  let skipDepth = 0;
  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) {
        skipDepth++;
      }
    },
    ontext(input) {
      if (skipDepth === 0) text += input;
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--;
    },
  });
  parser.write(html);
  parser.end();
  return text.trim();
}

export function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });
  turndownService.remove(["script", "style", "meta", "link", "noscript", "iframe", "object", "embed"]);
  return turndownService.turndown(html);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "Request timed out";
    if (error.name === "AbortError") return error.message || "Request aborted";
    return error.message;
  }
  return String(error);
}

async function persistFetchResult(
  url: string,
  title: string,
  text: string,
  format: string,
  options?: WebFetchExecutionOptions,
): Promise<WikiSaveResult> {
  return saveWikiEntry({
    root: options?.wikiRoot ?? wikiRoot(),
    topic: slugifyUrl(url),
    source: "web_fetch",
    queryOrUrl: url,
    format,
    title,
    text,
    timestamp: (options?.now ?? (() => new Date()))().toISOString(),
  });
}

function toWikiDetails(saved: WikiSaveResult): { saved: boolean; topic: string; pages: string[] } {
  return { saved: saved.saved, topic: saved.topic, pages: saved.pages };
}

export { MAX_RESPONSE_SIZE, DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS };
