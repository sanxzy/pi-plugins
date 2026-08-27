import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TOOL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { resolveSettingsForProject, type WebSettings } from "@xzy-ai/runtime";
import { errorResult, textResult } from "../results.ts";
import { expandedToolText, renderToolDetail, renderToolOutcome, toolResultFailed, toolResultText } from "../render.ts";
import { saveWikiEntry, slugifyQuery, type WikiSaveResult, wikiRoot } from "../wiki.ts";
import {
  EXA_MCP_URL,
  EXA_REST_URL,
  KEENABLE_PUBLIC_URL,
  KEENABLE_TITLE,
  KEENABLE_URL,
  NO_RESULTS,
  formatCanonicalSearchResults,
  isFallbackEligible,
  parseSearchResponse,
  searchProvider,
  type CanonicalWebSearchResult,
  type WebSearchAdapterRequest,
  type WebSearchCredentials,
  type WebSearchProvider,
} from "../web-search-adapter.ts";

export const EXA_URL = EXA_MCP_URL;
export const SEARCH_TIMEOUT_MS = 30_000;
const MAX_NUM_RESULTS = 20;

export {
  EXA_MCP_URL,
  EXA_REST_URL,
  KEENABLE_PUBLIC_URL,
  KEENABLE_TITLE,
  KEENABLE_URL,
  NO_RESULTS,
  formatCanonicalSearchResults,
  parseSearchResponse,
};
export type { CanonicalWebSearchResult as WebSearchResult, WebSearchProvider } from "../web-search-adapter.ts";

const webSearchParams = Type.Object({
  query: Type.String({ description: "Web search query" }),
  numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_NUM_RESULTS, description: "Number of results to return (maximum 20)" })),
  livecrawl: Type.Optional(Type.String({ enum: ["fallback", "preferred"], description: "Live crawl mode" })),
  type: Type.Optional(Type.String({ enum: ["auto", "fast", "deep"], description: "Search type" })),
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
  provider: WebSearchProvider;
  results?: CanonicalWebSearchResult[];
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
  /** Optional UI notification called when the provider fallback is used. */
  notify?: (message: string) => void;
}

/** Resolve the effective web settings for a project, or the default context when omitted. */
function resolveWebSettings(projectRoot?: string): WebSettings {
  return resolveSettingsForProject(projectRoot).tools.web;
}

/** Register the provider-configured `web_search` tool. */
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
      const notify = ctx.hasUI && typeof ctx.ui?.notify === "function"
        ? (message: string): void => {
          try {
            ctx.ui.notify(message, "warning");
          } catch {
            // Notification failure must not turn a successful search into an error.
          }
        }
        : undefined;
      return executeWebSearch(params, signal, undefined, { projectRoot: ctx.cwd, notify });
    },
    renderCall(args, theme, context) {
      return renderToolDetail(theme, "web_search", args.query, 96, context, args);
    },
    renderResult(result, options, theme, context) {
      const failed = toolResultFailed(result, context);
      const details = result.details as WebSearchDetails | undefined;
      const count = details?.results?.length ?? (toolResultText(result) ? 1 : 0);
      const label = `Web search • ${count} results`;
      return renderToolOutcome(theme, label, { ...options, expanded: Boolean(context.expanded ?? options.expanded) }, failed, toolResultText(result), result, context.args);
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
  const provider = settings.provider ?? "exa";
  const alternateProvider: WebSearchProvider = provider === "exa" ? "keenable" : "exa";
  const request: WebSearchAdapterRequest = {
    query: params.query,
    numResults: boundedNumResults(params.numResults, settings.defaultNumResults),
    type: params.type ?? settings.defaultSearchType,
    livecrawl: params.livecrawl ?? settings.defaultLivecrawl,
    ...(params.contextMaxCharacters === undefined ? {} : { contextMaxCharacters: params.contextMaxCharacters }),
  };
  const credentials: WebSearchCredentials = {
    exaApiKey: effectiveCredential(process.env.EXA_API_KEY, settings.exaApiKey),
    keenableApiKey: effectiveCredential(process.env.KEENABLE_API_KEY, settings.keenableApiKey),
  };
  const timeoutSignal = AbortSignal.timeout(settings.searchTimeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  try {
    const response = await searchProvider(provider, request, settings, requestSignal, credentials);
    return completeSearch(provider, params.query, response, options);
  } catch (firstError) {
    if (!isFallbackEligible(firstError)) {
      return errorResult(safeErrorMessage(firstError, credentials), { query: params.query, provider });
    }
    if (requestSignal.aborted) {
      return errorResult(signal?.aborted ? "Request aborted" : "Request timed out", { query: params.query, provider });
    }

    safeNotify(options?.notify, `Web search: ${providerLabel(provider)} limit reached; falling back to ${providerLabel(alternateProvider)}.`);
    if (requestSignal.aborted) {
      return errorResult(signal?.aborted ? "Request aborted" : "Request timed out", { query: params.query, provider });
    }
    try {
      const response = await searchProvider(alternateProvider, request, settings, requestSignal, credentials);
      return completeSearch(alternateProvider, params.query, response, options);
    } catch (secondError) {
      return errorResult(combinedFailureMessage(provider, firstError, alternateProvider, secondError, credentials), {
        query: params.query,
        provider: alternateProvider,
      });
    }
  }
}

async function completeSearch(
  provider: WebSearchProvider,
  query: string,
  response: { results: CanonicalWebSearchResult[]; text?: string },
  options?: WebSearchExecutionOptions,
): Promise<AgentToolResult<WebSearchDetails>> {
  const resultText = response.results.length > 0
    ? formatCanonicalSearchResults(response.results)
    : response.text ?? NO_RESULTS;
  if (resultText === NO_RESULTS) return textResult(NO_RESULTS, { query, provider });
  if (!resultText.trim()) return textResult(`Web Search: ${query}\n\n${resultText}`, { query, provider });

  const details: WebSearchDetails = { query, provider };
  if (response.results.length > 0) details.results = response.results;
  const saved = await persistSearchResult(query, resultText, options);
  details.wiki = toWikiDetails(saved);
  if (saved.error) details.wikiSaveError = saved.error;
  return textResult(`Web Search: ${query}\n\n${resultText}`, details);
}

function safeNotify(notify: ((message: string) => void) | undefined, message: string): void {
  if (!notify) return;
  try {
    notify(message);
  } catch {
    // UI notification is best effort and must not affect the provider result.
  }
}

function providerLabel(provider: WebSearchProvider): string {
  return provider === "exa" ? "Exa" : "Keenable";
}

function combinedFailureMessage(
  firstProvider: WebSearchProvider,
  firstError: unknown,
  secondProvider: WebSearchProvider,
  secondError: unknown,
  credentials: WebSearchCredentials,
): string {
  return `Search failed with ${providerLabel(firstProvider)} (${boundedFailure(safeErrorMessage(firstError, credentials))}); ${providerLabel(secondProvider)} fallback failed: ${boundedFailure(safeErrorMessage(secondError, credentials))}`;
}

function boundedNumResults(value: number | undefined, fallback: number): number {
  const requested = typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
  return Math.min(MAX_NUM_RESULTS, Math.max(1, requested));
}

function effectiveCredential(environmentValue: string | undefined, configuredValue: string | undefined): string | undefined {
  const value = environmentValue || configuredValue;
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function safeErrorMessage(error: unknown, credentials: WebSearchCredentials): string {
  return redactSensitiveText(toErrorMessage(error), credentials);
}

function redactSensitiveText(message: string, credentials: WebSearchCredentials): string {
  let redacted = message;
  const secrets = [credentials.exaApiKey, credentials.keenableApiKey]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("[REDACTED]");
    try {
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret) redacted = redacted.split(encoded).join("[REDACTED]");
    } catch {
      // Invalid URI code units do not change the exact-secret redaction above.
    }
  }
  return expandedToolText(redacted);
}

function boundedFailure(message: string): string {
  const normalized = message.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 239).trimEnd()}…`;
}

function webSearchDescription(): string {
  return `Use this tool for broad discovery: search the web and return current information beyond the knowledge cutoff. Start with a broad query to map a topic and surface candidate URLs and sources; then retry with narrower keyword combinations to narrow down the most relevant candidates. Search local wikis and references first with knowledge_search tool; fall back to this tool when local knowledge cache is absent or insufficient. This tool is very expensive, so use it sparingly; once candidate URLs have been identified, prefer web_fetch for subsequent retrieval and verification because web_fetch is free. Successful results from this tool are automatically saved to the local wiki for reuse. The current year is ${new Date().getFullYear()}; use this year when searching for recent information or current events.`;
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

export { webSearchParams };
