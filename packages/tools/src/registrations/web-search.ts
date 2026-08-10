import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readBoundedResponseBody } from "../http-body.ts";
import { errorResult, textResult } from "../results.ts";
import { saveWikiEntry, slugifyQuery, type WikiSaveResult, wikiRoot } from "../wiki.ts";

export const EXA_URL = "https://mcp.exa.ai/mcp";
export const NO_RESULTS = "No search results found. Please try a different query.";
export const SEARCH_TIMEOUT_MS = 30_000;
const DEFAULT_NUM_RESULTS = 8;
const MAX_NUM_RESULTS = 20;
const DEFAULT_LIVECRAWL = "fallback";
const DEFAULT_SEARCH_TYPE = "auto";
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

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
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<WebSearchDetails>> {
      return executeWebSearch(params, signal);
    },
  });
}

export async function executeWebSearch(
  params: WebSearchParams,
  signal?: AbortSignal,
  timeoutMs = SEARCH_TIMEOUT_MS,
  options?: WebSearchExecutionOptions,
): Promise<AgentToolResult<WebSearchDetails>> {
  try {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const apiKey = process.env.EXA_API_KEY;
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
            type: params.type ?? DEFAULT_SEARCH_TYPE,
            numResults: params.numResults ?? DEFAULT_NUM_RESULTS,
            livecrawl: params.livecrawl ?? DEFAULT_LIVECRAWL,
            ...(params.contextMaxCharacters === undefined ? {} : { contextMaxCharacters: params.contextMaxCharacters }),
          },
        },
      }),
      signal: requestSignal,
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText || "Request failed"}`);
    const body = await readBoundedResponseBody(response, MAX_RESPONSE_BYTES);
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
  return `Search the web using Exa and return current information beyond the knowledge cutoff. Search local LLM wikis first with llm_wikis_search; fall back to this tool when local information is absent or insufficient. Successful results from this tool are automatically saved to the local wiki for reuse. Supports configurable result counts, live crawling modes ('fallback' or 'preferred'), search types ('auto', 'fast', or 'deep'), and context length. The current year is ${new Date().getFullYear()}; use this year when searching for recent information or current events.`;
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
