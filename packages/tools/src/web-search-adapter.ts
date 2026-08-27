import type { WebSettings } from "@xzy-ai/runtime";
import { readBoundedResponseBody } from "./http-body.ts";

export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
export const EXA_REST_URL = "https://api.exa.ai/search";
export const KEENABLE_URL = "https://api.keenable.ai/v1/search";
export const KEENABLE_PUBLIC_URL = "https://api.keenable.ai/v1/search/public";
export const KEENABLE_TITLE = "Pi-Agent-C2";
export const NO_RESULTS = "No search results found. Please try a different query.";
export const KEENABLE_SNIPPET_MIN = 180;
export const KEENABLE_SNIPPET_MAX = 10_000;
const MAX_NORMALIZED_RESULTS = 20;

export type WebSearchProvider = "exa" | "keenable";

export interface WebSearchAdapterRequest {
  query: string;
  numResults: number;
  type: "auto" | "fast" | "deep";
  livecrawl: "fallback" | "preferred";
  contextMaxCharacters?: number;
}

export interface CanonicalWebSearchResult {
  title: string;
  url: string;
  published?: string;
  author?: string;
  snippet?: string;
}

export interface WebSearchProviderResponse {
  results: CanonicalWebSearchResult[];
  /** Provider text retained when an anonymous Exa MCP response cannot be parsed safely. */
  text?: string;
}

export interface WebSearchCredentials {
  exaApiKey?: string;
  keenableApiKey?: string;
}

export class WebSearchProviderError extends Error {
  readonly provider: WebSearchProvider;
  readonly status?: number;
  readonly tag?: string;
  readonly fallbackEligible: boolean;

  constructor(
    message: string,
    details: {
      provider: WebSearchProvider;
      status?: number;
      tag?: string;
      fallbackEligible?: boolean;
    },
  ) {
    super(message);
    this.name = "WebSearchProviderError";
    this.provider = details.provider;
    this.status = details.status;
    this.tag = details.tag;
    this.fallbackEligible = details.fallbackEligible === true;
  }
}

/** Return the API request body used by the keyed Exa REST transport. */
export function buildExaRestRequestBody(request: WebSearchAdapterRequest): Record<string, unknown> {
  const contents: Record<string, unknown> = {
    highlights: request.contextMaxCharacters === undefined
      ? true
      : { query: request.query, maxCharacters: request.contextMaxCharacters },
  };
  if (request.livecrawl === "preferred") contents.maxAgeHours = 0;
  return {
    query: request.query,
    type: request.type,
    numResults: request.numResults,
    stream: false,
    contents,
  };
}

/** Return the request body used by the Keenable JSON transport. */
export function buildKeenableRequestBody(request: WebSearchAdapterRequest): Record<string, unknown> {
  const snippetMaxLength = clampKeenableSnippetLength(request.contextMaxCharacters);
  return {
    query: request.query,
    max_results: request.numResults,
    ...(snippetMaxLength === undefined ? {} : { snippet_max_length: snippetMaxLength }),
  };
}

/** Keenable accepts snippets between 180 and 10,000 characters. */
export function clampKeenableSnippetLength(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(KEENABLE_SNIPPET_MAX, Math.max(KEENABLE_SNIPPET_MIN, Math.trunc(value)));
}

/**
 * Search through the configured provider. Credentials are resolved by the
 * caller so the adapter remains explicit about which secret belongs to which
 * provider and never places a credential in a URL.
 */
export async function searchProvider(
  provider: WebSearchProvider,
  request: WebSearchAdapterRequest,
  settings: WebSettings,
  signal: AbortSignal,
  credentials: WebSearchCredentials,
): Promise<WebSearchProviderResponse> {
  if (provider === "exa") {
    const apiKey = nonEmpty(credentials.exaApiKey);
    return apiKey
      ? searchExaRest(request, settings, signal, apiKey)
      : searchExaMcp(request, settings, signal);
  }
  return searchKeenable(request, settings, signal, nonEmpty(credentials.keenableApiKey));
}

async function searchExaRest(
  request: WebSearchAdapterRequest,
  settings: WebSettings,
  signal: AbortSignal,
  apiKey: string,
): Promise<WebSearchProviderResponse> {
  const response = await fetch(EXA_REST_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(buildExaRestRequestBody(request)),
    signal,
  });
  const body = await readResponseBody(response, settings);
  if (!response.ok) throw httpProviderError(response, "exa", body);
  return parseExaRestResponse(body, request.numResults);
}

async function searchExaMcp(
  request: WebSearchAdapterRequest,
  settings: WebSettings,
  signal: AbortSignal,
): Promise<WebSearchProviderResponse> {
  const response = await fetch(EXA_MCP_URL, {
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
          query: request.query,
          type: request.type,
          numResults: request.numResults,
          livecrawl: request.livecrawl,
          ...(request.contextMaxCharacters === undefined ? {} : { contextMaxCharacters: request.contextMaxCharacters }),
        },
      },
    }),
    signal,
  });
  const body = await readResponseBody(response, settings);
  if (!response.ok) throw httpProviderError(response, "exa", body);

  const parsed = parseSearchResponse(body, request.numResults);
  if (parsed.malformed) {
    throw new WebSearchProviderError("Malformed search response body", { provider: "exa" });
  }
  if (parsed.error) {
    throw new WebSearchProviderError(`Search request failed: ${parsed.error}`, {
      provider: "exa",
      tag: parsed.tag,
      fallbackEligible: isLimitSignal(undefined, parsed.error, parsed.tag),
    });
  }
  return {
    results: parsed.results ?? [],
    ...(parsed.results && parsed.results.length > 0 ? {} : { text: parsed.text ?? NO_RESULTS }),
  };
}

async function searchKeenable(
  request: WebSearchAdapterRequest,
  settings: WebSettings,
  signal: AbortSignal,
  apiKey: string | undefined,
): Promise<WebSearchProviderResponse> {
  const keyed = apiKey !== undefined;
  const response = await fetch(keyed ? KEENABLE_URL : KEENABLE_PUBLIC_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(keyed ? { "X-API-Key": apiKey } : { "X-Keenable-Title": KEENABLE_TITLE }),
    },
    body: JSON.stringify(buildKeenableRequestBody(request)),
    signal,
  });
  const body = await readResponseBody(response, settings);
  if (!response.ok) throw httpProviderError(response, "keenable", body);
  return parseKeenableResponse(body, request.numResults);
}

async function readResponseBody(response: Response, settings: WebSettings): Promise<string> {
  // HTTP 429 is independently sufficient to trigger the alternate provider.
  // Do not let a bounded-body failure hide that status, but still release the
  // response stream before the caller makes the second request.
  if (!response.ok && response.status === 429) {
    try { await response.body?.cancel(); } catch { /* best effort */ }
    return "";
  }
  const body = await readBoundedResponseBody(
    response,
    settings.maxResponseBytes,
    responseLimitMessage(settings.maxResponseBytes),
  );
  return new TextDecoder().decode(body);
}

function responseLimitMessage(maximumBytes: number): string {
  return maximumBytes === 5 * 1024 * 1024
    ? "Response too large (exceeds 5MB limit)"
    : "Response too large (exceeds configured response limit)";
}

function httpProviderError(response: Response, provider: WebSearchProvider, body: string): WebSearchProviderError {
  const error = parseErrorBody(body);
  return new WebSearchProviderError(
    `HTTP ${response.status}: ${response.statusText || "Request failed"}`,
    {
      provider,
      status: response.status,
      tag: error.tag,
      fallbackEligible: isLimitSignal(response.status, error.message, error.tag),
    },
  );
}

function parseExaRestResponse(body: string, maxResults = MAX_NORMALIZED_RESULTS): WebSearchProviderResponse {
  const parsed = parseJson(body);
  if (!isRecord(parsed)) throw new WebSearchProviderError("Malformed search response body", { provider: "exa" });
  const error = parseErrorBody(body);
  if (error.message !== undefined || error.tag !== undefined) {
    throw new WebSearchProviderError(`Search request failed: ${error.message ?? error.tag ?? "Unknown error"}`, {
      provider: "exa",
      tag: error.tag,
      fallbackEligible: isLimitSignal(undefined, error.message, error.tag),
    });
  }
  if (!Array.isArray(parsed.results)) {
    throw new WebSearchProviderError("Malformed search response body", { provider: "exa" });
  }
  return { results: normalizeExaResults(parsed.results, maxResults) };
}

function parseKeenableResponse(body: string, maxResults = MAX_NORMALIZED_RESULTS): WebSearchProviderResponse {
  const parsed = parseJson(body, "keenable");
  if (!isRecord(parsed)) throw new WebSearchProviderError("Malformed search response body", { provider: "keenable" });
  const error = parseErrorBody(body);
  if (error.message !== undefined || error.tag !== undefined) {
    throw new WebSearchProviderError(`Search request failed: ${error.message ?? error.tag ?? "Unknown error"}`, {
      provider: "keenable",
      tag: error.tag,
      fallbackEligible: isLimitSignal(undefined, error.message, error.tag),
    });
  }
  if (!Array.isArray(parsed.results)) {
    throw new WebSearchProviderError("Malformed search response body", { provider: "keenable" });
  }
  return { results: normalizeKeenableResults(parsed.results, maxResults) };
}

function parseJson(body: string, provider: WebSearchProvider = "exa"): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new WebSearchProviderError("Malformed search response body", { provider });
  }
}

function normalizeExaResults(value: unknown[], maxResults = MAX_NORMALIZED_RESULTS): CanonicalWebSearchResult[] {
  const results: CanonicalWebSearchResult[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const url = textValue(item.url);
    if (!url) continue;
    const titleValue = textValue(item.title);
    const snippet = firstText(item.highlights) ?? textValue(item.summary) ?? textValue(item.text);
    results.push({
      title: titleValue && titleValue !== "N/A" ? titleValue : url,
      url,
      ...(optionalText(item.publishedDate) ? { published: optionalText(item.publishedDate) } : {}),
      ...(optionalText(item.author) ? { author: optionalText(item.author) } : {}),
      ...(snippet ? { snippet } : {}),
    });
  }
  return results.slice(0, boundedResultLimit(maxResults));
}

function normalizeKeenableResults(value: unknown[], maxResults = MAX_NORMALIZED_RESULTS): CanonicalWebSearchResult[] {
  const results: CanonicalWebSearchResult[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const url = textValue(item.url);
    if (!url) continue;
    const titleValue = textValue(item.title);
    const snippet = optionalText(item.snippet) ?? optionalText(item.description);
    results.push({
      title: titleValue && titleValue !== "N/A" ? titleValue : url,
      url,
      ...(optionalText(item.published_at) ? { published: optionalText(item.published_at) } : {}),
      ...(optionalText(item.author) ? { author: optionalText(item.author) } : {}),
      ...(snippet ? { snippet } : {}),
    });
  }
  return results.slice(0, boundedResultLimit(maxResults));
}

function boundedResultLimit(value: number): number {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? Math.min(MAX_NORMALIZED_RESULTS, Math.max(1, value))
    : MAX_NORMALIZED_RESULTS;
}

function firstText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const parts = value.map((item) => optionalText(item)).filter((item): item is string => item !== undefined);
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }
  return optionalText(value);
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(value: unknown): string | undefined {
  const text = textValue(value);
  return text.length > 0 && text !== "N/A" ? text : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

interface ErrorBody {
  message?: string;
  tag?: string;
}

function parseErrorBody(body: string): ErrorBody {
  const parsed = parseJsonWithoutThrow(body);
  return isRecord(parsed) ? extractErrorBody(parsed) : {};
}

function extractErrorBody(parsed: Record<string, unknown>): ErrorBody {
  const rawError = parsed.error;
  const messages: string[] = [];
  if (typeof rawError === "string" && rawError.trim()) messages.push(rawError.trim());
  if (isRecord(rawError) && typeof rawError.message === "string" && rawError.message.trim()) {
    messages.push(rawError.message.trim());
  }
  if (typeof parsed.message === "string" && parsed.message.trim() && !messages.includes(parsed.message.trim())) {
    messages.push(parsed.message.trim());
  }
  const nestedData = isRecord(rawError) && isRecord(rawError.data) ? rawError.data : undefined;
  const topData = isRecord(parsed.data) ? parsed.data : undefined;
  const tag = [
    parsed.tag,
    isRecord(rawError) ? rawError.tag : undefined,
    nestedData?.tag,
    topData?.tag,
  ].find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return {
    ...(messages.length > 0 ? { message: messages.join(": ") } : {}),
    ...(tag ? { tag: tag.trim() } : {}),
  };
}

function parseJsonWithoutThrow(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Explicit credit/quota exhaustion wording, used to narrow HTTP 402 to credit exhaustion only. */
const CREDIT_EXHAUSTION_PATTERNS = [
  /\b(?:insufficient|out\s+of)\s+(?:credits?|quota)\b/,
  /\bno\s+(?:more\s+)?(?:credits?|quota)\b(?!\s+(?:(?:has|have|is|are|was|were)\s+(?:been\s+)?)?(?:required|configured|needed|requested|necessary|spent|used|consumed)\b)/,
  /\b(?:credit|credits|quota|budget)\s+(?:exhaustion|depletion)\b/,
  /\b(?:credits?|quota|budget)(?:\s+(?:limit|budget))?\s+(?:(?:has|have|is|are|was|were)\s+(?:been\s+)?)?(?:exhausted|depleted|unavailable|used\s+up|run\s+out|ran\s+out)\b/,
];

/** Identify only explicit rate/quota/credit exhaustion signals. */
export function isLimitSignal(status?: number, message?: string, tag?: string): boolean {
  if (status === 429) return true;
  if (status === 401 || status === 403 || status === 400 || status === 422) return false;
  // Generic server failures never trigger provider switching, even when the
  // body mentions limits or credits.
  if (status !== undefined && status >= 500 && status < 600) return false;
  const combined = `${tag ?? ""} ${message ?? ""}`.toLowerCase();
  // Exa's X402 payment challenge is not quota exhaustion, even when a
  // response happens to mention credits. It must never trigger a provider
  // switch based on a generic payment-required signal.
  const normalized = combined.replace(/[_-]+/g, " ");
  if (normalized.includes("payment required")) return false;
  if (isNegatedLimit(normalized)) return false;
  // HTTP 402 qualifies only for explicit credit exhaustion. Rate limits,
  // quota caps, and throttling are different signals on this status.
  if (status === 402) {
    return CREDIT_EXHAUSTION_PATTERNS.some((pattern) => pattern.test(normalized));
  }
  const explicitLimit = [
    /\brate\s+limit(?:ed|ing)?\b/,
    /\btoo\s+many\s+requests?\b/,
    /\b(?:request|requests|usage|monthly|team|account|api\s+key)\s+(?:(?:has|have|is|are|was|were)\s+(?:been\s+)?)?limit\s+(?:exceeded|exhausted|depleted|reached|hit)\b/,
    /\b(?:quota|credit|credits|budget)(?:\s+(?:limit|budget))?\s+(?:(?:has|have|is|are|was|were)\s+(?:been\s+)?)?(?:exceeded|reached|hit)\b/,
    ...CREDIT_EXHAUSTION_PATTERNS,
    /\brequests?\s+(?:(?:has|have|is|are|was|were)\s+)?(?:currently\s+)?(?:been\s+|being\s+)?throttl(?:ed|ing)\b/,
  ].some((pattern) => pattern.test(normalized));
  return explicitLimit;
}

function isNegatedLimit(value: string): boolean {
  return /\b(?:not|never)\s+(?:(?:currently|actually|yet)\s+)?(?:out\s+of\s+(?:credits?|quota)|too\s+many\s+requests?|(?:rate\s+)?limit(?:ed|ing)?|(?:credits?|quota|budget)\s+(?:exceeded|exhausted|depleted|unavailable|reached|hit|used\s+up|ran\s+out)|requests?\s+(?:(?:has|have|is|are|was|were)\s+)?(?:currently\s+)?(?:been\s+|being\s+)?throttl(?:ed|ing))\b/.test(value);
}

export function isFallbackEligible(error: unknown): error is WebSearchProviderError {
  return error instanceof WebSearchProviderError && error.fallbackEligible;
}

/**
 * Parse the current Exa MCP response contract. It accepts direct JSON-RPC
 * bodies and SSE `data:` frames, while retaining the original text when it is
 * not in the observed Title/URL/Highlights format.
 */
export interface ParsedSearchResponse {
  text?: string;
  error?: string;
  tag?: string;
  malformed?: boolean;
  results?: CanonicalWebSearchResult[];
}

export function parseSearchResponse(body: string, maxResults = MAX_NORMALIZED_RESULTS): ParsedSearchResponse {
  const trimmed = body.trim();
  if (!trimmed) return { text: NO_RESULTS };

  const direct = parseJsonPayload(trimmed, maxResults);
  if (direct.kind === "text" || direct.kind === "error" || direct.kind === "empty") return direct.value;
  if (direct.kind === "malformed" && trimmed.startsWith("{")) return { malformed: true };

  let sawData = false;
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    sawData = true;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const parsed = parseJsonPayload(payload, maxResults);
    if (parsed.kind === "text" || parsed.kind === "error") return parsed.value;
  }
  if (sawData) return { text: NO_RESULTS };
  return { error: "Malformed search response body" };
}

function parseJsonPayload(payload: string, maxResults = MAX_NORMALIZED_RESULTS):
  | { kind: "text"; value: { text: string; results?: CanonicalWebSearchResult[] } }
  | { kind: "error"; value: { error: string; tag?: string } }
  | { kind: "empty"; value: { text: string } }
  | { kind: "malformed" } {
  const parsed = parseJsonWithoutThrow(payload);
  if (!isRecord(parsed)) return { kind: "malformed" };
  if (parsed.error !== undefined) {
    const error = extractErrorBody(parsed);
    return {
      kind: "error",
      value: {
        error: error.message ?? "Unknown JSON-RPC error",
        ...(error.tag ? { tag: error.tag } : {}),
      },
    };
  }
  const result = parsed.result;
  if (!isRecord(result)) return { kind: "malformed" };
  if (result.isError === true) {
    const error = extractMcpToolError(result);
    return { kind: "error", value: error };
  }
  const content = result.content;
  if (!Array.isArray(content)) return { kind: "malformed" };
  const item = content.find((entry): entry is { text: string } => {
    return Boolean(entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).text === "string" && (entry as Record<string, unknown>).text);
  });
  if (!item) return { kind: "empty", value: { text: NO_RESULTS } };
  const results = parseExaMcpText(item.text, maxResults);
  return results.length > 0
    ? { kind: "text", value: { text: item.text, results } }
    : { kind: "text", value: { text: item.text } };
}

function extractMcpToolError(result: Record<string, unknown>): { error: string; tag?: string } {
  const content = Array.isArray(result.content) ? result.content : [];
  const contentItem = content.find((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.text === "string" && entry.text.trim().length > 0);
  const contentText = contentItem && typeof contentItem.text === "string" ? contentItem.text.trim() : undefined;
  const embedded = contentText ? parseJsonWithoutThrow(contentText) : undefined;
  const resultError = extractErrorBody(result);
  const embeddedError = isRecord(embedded) ? extractErrorBody(embedded) : {};
  const message = resultError.message ?? embeddedError.message ?? contentText ?? "MCP tool request failed";
  const contentTag = content
    .filter(isRecord)
    .map((entry) => entry.tag)
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  const tag = resultError.tag ?? embeddedError.tag ?? contentTag;
  return { error: message, ...(tag ? { tag: tag.trim() } : {}) };
}

function parseExaMcpText(text: string, maxResults = MAX_NORMALIZED_RESULTS): CanonicalWebSearchResult[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const sections = normalized
    .split(/\n{2,}---\n{2,}(?=Title:\s*)/)
    .map((section) => section.trim())
    .filter((section) => section.startsWith("Title:"));
  const results: CanonicalWebSearchResult[] = [];
  for (const section of sections) {
    const lines = section.split("\n");
    const title = lineValue(lines, "Title");
    const url = lineValue(lines, "URL");
    if (!url) continue;
    const published = optionalLineValue(lines, "Published");
    const author = optionalLineValue(lines, "Author");
    const highlightsIndex = lines.findIndex((line) => /^Highlights:\s*$/.test(line.trim()));
    const snippet = highlightsIndex < 0 ? undefined : lines.slice(highlightsIndex + 1).join("\n").trim() || undefined;
    results.push({
      title: title && title !== "N/A" ? title : url,
      url,
      ...(published ? { published } : {}),
      ...(author ? { author } : {}),
      ...(snippet ? { snippet } : {}),
    });
  }
  return results.slice(0, boundedResultLimit(maxResults));
}

function lineValue(lines: string[], label: string): string {
  const line = lines.find((entry) => entry.startsWith(`${label}:`));
  return line ? line.slice(label.length + 1).trim() : "";
}

function optionalLineValue(lines: string[], label: string): string | undefined {
  const value = lineValue(lines, label);
  return value && value !== "N/A" ? value : undefined;
}

/** Render every provider's normalized result in one stable readable format. */
export function formatCanonicalSearchResults(results: CanonicalWebSearchResult[]): string {
  return results.map((result) => {
    const lines = [`Title: ${result.title}`, `URL: ${result.url}`];
    if (result.published) lines.push(`Published: ${result.published}`);
    if (result.author) lines.push(`Author: ${result.author}`);
    if (result.snippet) lines.push("Highlights:", result.snippet);
    return lines.join("\n");
  }).join("\n\n---\n\n");
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
