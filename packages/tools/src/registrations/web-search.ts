import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderToolDetail, renderToolResult, toolResultFailed } from "../render.ts";
import { Type } from "typebox";
import { TOOL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { resolveSettingsForProject, type WebSettings } from "@xzy-ai/runtime";
import { readBoundedResponseBody } from "../http-body.ts";
import { errorResult, textResult } from "../results.ts";
import { saveWikiEntry, slugifyQuery, type WikiSaveResult, wikiRoot } from "../wiki.ts";

export const EXA_URL = "https://mcp.exa.ai/mcp";
export const NO_RESULTS = "No search results found. Please try a different query.";
export const SEARCH_TIMEOUT_MS = 30_000;
const MAX_NUM_RESULTS = 20;

const webSearchParams = Type.Object({
  query: Type.String({ description: "Web search query" }),
  numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_NUM_RESULTS, description: "Number of results to return (maximum 20)" })),
  livecrawl: Type.Optional(Type.Union([Type.Literal("fallback"), Type.Literal("preferred")], { description: "Live crawl mode" })),
  type: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("fast"), Type.Literal("deep")], { description: "Search type" })),
  contextMaxCharacters: Type.Optional(Type.Integer({ minimum: 1, maximum: 50_000, description: "Maximum context characters" })),
});

type WebSearchParams = {
  query: string;
  numResults?: number;
  livecrawl?: "fallback" | "preferred";
  type?: "auto" | "fast" | "deep";
  contextMaxCharacters?: number;
};

export interface WebSearchDetails {
  query: string;
  provider: "exa";
  wiki?: {
    saved: boolean;
    topic: string;
    pages: string[];
  };
  wikiSaveError?: string;
}

export interface WebSearchExecutionOptions {
  wikiRoot?: string;
  now?: () => Date;
  /** Project root used to resolve centralized web settings (defaults when omitted). */
  projectRoot?: string;
}

/** Resolve the effective web settings for a project, or the default context when omitted. */
function resolveWebSettings(projectRoot?: string): WebSettings {
  return resolveSettingsForProject(projectRoot).tools.web;
}

/** Register the Exa-backed `web_search` tool. */
export function registerWebSearchTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "web_search",
    label: "Web search",
    description: webSearchDescription(),
    parameters: webSearchParams,
    async execute(
      _toolCallId: string,
      params: WebSearchParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<WebSearchDetails>> {
      return executeWebSearch(params, signal, undefined, { projectRoot: ctx.cwd });
    },
    renderCall(args, theme) {
      return renderToolDetail(theme, "web_search", args.query);
    },
    renderResult(_result, options, theme, context) {
      return renderToolResult(theme, "web search complete", toolResultFailed(_result, context), options.isPartial);
    },
  });
}

export async function executeWebSearch(
  params: WebSearchParams,
  signal?: AbortSignal,
  timeoutMs?: number,
  options?: WebSearchExecutionOptions,
): Promise<AgentToolResult<WebSearchDetails>> {
  return processWithLog({ operation: TOOL_OPERATIONS.WEB_SEARCH_EXECUTE, parameters: { query: params.query } }, async () => {
    const settings = resolveWebSettings(options?.projectRoot);
    // An explicit timeout override wins over the centralized search timeout.
    const effectiveSettings: WebSettings = timeoutMs === undefined ? settings : { ...settings, searchTimeoutMs: timeoutMs };
    return executeWebSearchInner(params, signal, effectiveSettings, options);
  });
}

async function executeWebSearchInner(
  params: WebSearchParams,
  signal: AbortSignal | undefined,
  settings: WebSettings,
  options?: WebSearchExecutionOptions,
): Promise<AgentToolResult<WebSearchDetails>> {
  try {
    const timeoutSignal = AbortSignal.timeout(settings.searchTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const apiKey = process.env.EXA_API_KEY || settings.exaApiKey;
    const url = exaUrl(apiKey);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "web_search_exa",
          arguments: {
            query: params.query,
            type: params.type ?? settings.defaultSearchType,
            numResults: params.numResults ?? settings.defaultNumResults,
            livecrawl: params.livecrawl ?? settings.defaultLivecrawl,
            ...(params.contextMaxCharacters === undefined ? {} : { contextMaxCharacters: params.contextMaxCharacters }),
          },
        },
      }),
      signal: requestSignal,
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText || "Request failed"}`);
    const body = await readBoundedResponseBody(
      response,
      settings.maxResponseBytes,
      responseLimitMessage(settings.maxResponseBytes),
    );
    const output = parseSearchResponse(new TextDecoder().decode(body));
    if (output.malformed) throw new Error("Malformed search response body");
    if (output.error) throw new Error(`Search request failed: ${output.error}`);
    const resultText = output.text ?? NO_RESULTS;
    if (resultText === NO_RESULTS) return textResult(NO_RESULTS, { query: params.query, provider: "exa" });
    if (!resultText.trim()) return textResult(`Web Search: ${params.query}\n\n${resultText}`, { query: params.query, provider: "exa" });

    const details: WebSearchDetails = { query: params.query, provider: "exa" };
    const saved = await persistSearchResult(params.query, resultText, options);
    details.wiki = toWikiDetails(saved);
    if (saved.error) details.wikiSaveError = saved.error;
    return textResult(`Web Search: ${params.query}\n\n${resultText}`, details);
  } catch (error) {
    return errorResult(toErrorMessage(error), { query: params.query, provider: "exa" });
  }
}

function responseLimitMessage(maximumBytes: number): string {
  return maximumBytes === 5 * 1024 * 1024
    ? "Response too large (exceeds 5MB limit)"
    : "Response too large (exceeds configured response limit)";
}

function exaUrl(apiKey: string | undefined): string {
  if (!apiKey) return EXA_URL;
  const url = new URL(EXA_URL);
  url.searchParams.set("exaApiKey", apiKey);
  return url.toString();
}

interface ParsedSearchResponse {
  text?: string;
  error?: string;
  malformed?: boolean;
}

function parseSearchResponse(body: string): ParsedSearchResponse {
  const trimmed = body.trim();
  if (!trimmed) return { text: NO_RESULTS };

  const direct = parseJsonPayload(trimmed);
  if (direct.kind === "text" || direct.kind === "error" || direct.kind === "empty") return direct.value;
  if (direct.kind === "malformed") {
    // A body beginning with JSON is expected to be a direct JSON-RPC payload.
    // SSE bodies can contain event lines before their data frame.
    if (trimmed.startsWith("{")) return { malformed: true };
  }

  let sawData = false;
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    sawData = true;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const parsed = parseJsonPayload(payload);
    if (parsed.kind === "text" || parsed.kind === "error") return parsed.value;
    // Empty frames are skipped; a later frame may carry the result.
  }
  if (sawData) return { text: NO_RESULTS };
  return { error: "Malformed search response body" };
}

function parseJsonPayload(payload: string):
  | { kind: "text"; value: { text: string } }
  | { kind: "error"; value: { error: string } }
  | { kind: "empty"; value: { text: string } }
  | { kind: "malformed" } {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object") return { kind: "malformed" };
    const record = parsed as Record<string, unknown>;
    if (record.error && typeof record.error === "object") {
      const error = record.error as Record<string, unknown>;
      return { kind: "error", value: { error: typeof error.message === "string" ? error.message : "Unknown JSON-RPC error" } };
    }
    const result = record.result;
    if (!result || typeof result !== "object") return { kind: "malformed" };
    const content = (result as Record<string, unknown>).content;
    if (!Array.isArray(content)) return { kind: "malformed" };
    const item = content.find((entry): entry is { text: string } => {
      return Boolean(entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).text === "string" && (entry as Record<string, unknown>).text);
    });
    return item ? { kind: "text", value: { text: item.text } } : { kind: "empty", value: { text: NO_RESULTS } };
  } catch {
    return { kind: "malformed" };
  }
}

function webSearchDescription(): string {
  return `Use this tool for broad discovery: search the web and return current information beyond the knowledge cutoff. Start with a broad query to map a topic and surface candidate URLs and sources; then retry with narrower keyword combinations to narrow down the most relevant candidates. Search local wikis and references first with knowledge_search tool; fall back to this tool when local information is absent or insufficient. This tool is very expensive, so use it sparingly; once candidate URLs have been identified, prefer web_fetch for subsequent retrieval and verification because web_fetch is free. Successful results from this tool are automatically saved to the local wiki for reuse. The current year is ${new Date().getFullYear()}; use this year when searching for recent information or current events.`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "Request timed out";
    if (error.name === "AbortError") return error.message || "Request aborted";
    return error.message;
  }
  return String(error);
}

async function persistSearchResult(
  query: string,
  text: string,
  options?: WebSearchExecutionOptions,
): Promise<WikiSaveResult> {
  return saveWikiEntry({
    root: options?.wikiRoot ?? wikiRoot(),
    topic: slugifyQuery(query),
    source: "web_search",
    queryOrUrl: query,
    format: "markdown",
    title: `Web Search: ${query}`,
    text,
    timestamp: (options?.now ?? (() => new Date()))().toISOString(),
  });
}

function toWikiDetails(saved: WikiSaveResult): { saved: boolean; topic: string; pages: string[] } {
  return { saved: saved.saved, topic: saved.topic, pages: saved.pages };
}

export { webSearchParams, parseSearchResponse };
