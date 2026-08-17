import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const SENSITIVE_KEY = /(?:^|[_-])(?:access|refresh|client|id|api)?[_-]?(?:token|secret|password|credential|key|authorization|auth|bearer|code|state)(?:$|[_-])|(?:^|[_-])client[_-]?id(?:$|[_-])|(?:^|[_-])(?:chat|file|artifact)[_-]?id(?:$|[_-])|(?:^|[_-])request[_-]?id(?:$|[_-])|(?:^|[_-])trace[_-]?id(?:$|[_-])/i;

function sensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase());
}

function sanitizeTraceValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return expandedToolText(value);
  if (typeof value === "bigint") return `${value}n`;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeTraceValue(item, seen));
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, sensitiveKey(key) ? "[redacted]" : sanitizeTraceValue(item, seen)]));
}

/** Keep tool activity readable without copying model-facing payloads into the TUI. */
export function compactToolText(value: unknown, maxLength = 80): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  const singleLine = expandedToolText(text).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/** Serialize a value for expanded tracing without letting unusual values break rendering. */
function traceValue(value: unknown): string {
  try {
    return JSON.stringify(sanitizeTraceValue(value), null, 2) ?? String(value ?? "");
  } catch {
    return expandedToolText(String(value ?? ""));
  }
}

/** Render one user-facing activity line for a pi-c2 tool call. */
export function renderToolCall(
  theme: Theme,
  label: string,
  activity?: string,
  context?: ToolRenderContextLike,
  traceArgs?: unknown,
): Text {
  const suffix = activity ? theme.fg("muted", ` ${compactToolText(activity)}`) : "";
  const line = theme.fg("toolTitle", theme.bold(label)) + suffix;
  if (context?.expanded && traceArgs !== undefined) {
    return new Text(`${line}\nArguments:\n${traceValue(traceArgs)}`, 0, 0);
  }
  return new Text(line, 0, 0);
}

/** Render an identifier as a safe, compact activity detail. */
export function renderToolDetail(
  theme: Theme,
  label: string,
  value: unknown,
  maxLength = 96,
  context?: ToolRenderContextLike,
  traceArgs?: unknown,
): Text {
  return renderToolCall(theme, label, compactToolText(value, maxLength), context, traceArgs);
}

/** Serialize only the result content that is delivered to the model. */
export function toolResultTrace(
  result: { content?: unknown; details?: unknown } | undefined,
  _context?: ToolRenderContextLike,
): string {
  const content = result?.content ?? [];
  if (Array.isArray(content) && content.length > 0) return traceValue(content);
  if (result?.details && typeof result.details === "object") {
    const visible = Object.fromEntries(Object.entries(result.details).filter(([key]) => ["answer", "message"].includes(key)));
    if (Object.keys(visible).length > 0) return traceValue(visible);
  }
  if (result?.details && typeof result.details === "object" && "structuredContent" in result.details) {
    return traceValue((result.details as { structuredContent?: unknown }).structuredContent);
  }
  return traceValue(content);
}

/** Render a compact outcome without exposing the tool's model-facing result. */
export interface ToolRenderContextLike {
  readonly isError?: boolean;
  readonly expanded?: boolean;
  readonly args?: unknown;
}

/** Detect resolved tool failures without rendering their model-facing details. */
export function toolResultFailed(
  result: { content?: unknown; details?: unknown } | undefined,
  context?: ToolRenderContextLike,
): boolean {
  if (context?.isError) return true;
  const details = result?.details;
  if (details && typeof details === "object") {
    const record = details as Record<string, unknown>;
    if (
      record.isError === true ||
      record.success === false ||
      record.sent === false ||
      record.unknown === true ||
      record.denied === true ||
      typeof record.failure === "string" ||
      typeof record.reason === "string" && record.status === "failed"
    ) return true;
  }
  const content = result?.content;
  if (Array.isArray(content)) {
    return content.some((block) =>
      Boolean(block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string" &&
        String((block as Record<string, unknown>).text).trimStart().startsWith("Error:")),
    );
  }
  return false;
}

export interface ToolRenderResultOptionsLike {
  readonly expanded?: boolean;
  readonly isPartial?: boolean;
}

/** Preserve expanded model-facing text while removing terminal controls and credentials. */
export function expandedToolText(value: unknown): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text
    .replace(/(https?:\/\/)([^/@\s]+):([^/@\s]+)@/gi, "$1[redacted]@")
    .replace(/([?&](?:token|key|secret|code|state|password|authorization|credential|access[_-]?token|refresh[_-]?token|client[_-]?(?:secret|id)|api[_-]?secret)=)[^&#\s]+/gi, "$1[redacted]")
    .replace(/(\b(?:bearer|basic)\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[redacted]")
    .replace(/(["'](?:chat[_-]?id|file[_-]?id|artifact[_-]?id|token|key|secret|code|state|password|authorization|credential|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?(?:secret|id)|api[_-]?secret|request[_-]?id|trace[_-]?id)["']\s*:\s*)("[^"]*"|[^,}\s]+)/gi, '$1"[redacted]"')
    .replace(/(\b(?:access[_-]?token|refresh[_-]?token|(?:api|auth|bearer)[_-]?(?:token|key)|client[_-]?(?:secret|id)|api[_-]?secret|token|secret|password|credential|authorization|request[_-]?id|trace[_-]?id|(?:chat|file|artifact)[_-]?id)\b\s*[=:]\s*)(?!\[redacted\])([^\s,;&}\]]+?)(?=[\s,;&}\]]|$)/gi, "$1[redacted]")
    .replace(/(\b(?:authorization|auth|bearer)\b\s*[=:]\s*)([^\r\n,;&}\]]+)/gi, "$1[redacted]")
    .replace(/(?:\bbot\d+:[A-Za-z0-9_-]+\b|\bchat[_-]?id\s*[:=]\s*["']?\d+["']?)/gi, "[redacted]")
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\u001b/g, "");
}

/** Extract text-like tool output for an explicitly expanded result view. */
export function toolResultText(result: { content?: unknown; details?: unknown } | undefined): string {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const text = blocks
    .filter((block): block is Record<string, unknown> => Boolean(block && typeof block === "object"))
    .map((block) => {
      if (typeof block.text === "string") return block.text;
      if (block.type === "image" && typeof block.mimeType === "string") return `[image: ${block.mimeType}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
  if (text) return expandedToolText(text);
  const structured = result?.details && typeof result.details === "object" && "structuredContent" in result.details
    ? (result.details as { structuredContent?: unknown }).structuredContent
    : undefined;
  if (structured === undefined) return "";
  try {
    return traceValue(structured);
  } catch {
    return "";
  }
}

/** Render a collapsed outcome and optionally append full safe detail when expanded. */
export function renderToolOutcome(
  theme: Theme,
  label: string,
  options: ToolRenderResultOptionsLike,
  failed = false,
  expandedDetail = "",
  traceResult?: { content?: unknown; details?: unknown },
  traceArgs?: unknown,
): Text {
  if (options.isPartial) return new Text(theme.fg("dim", "…"), 0, 0);
  const marker = failed ? "✗" : "✓";
  const line = theme.fg(failed ? "warning" : "success", `${marker} ${compactToolText(label, 160)}`);
  if (options.expanded && !failed) {
    const sections: string[] = [];
    if (traceResult) sections.push(`Result:\n${toolResultTrace(traceResult)}`);
    else if (expandedDetail) sections.push(expandedToolText(expandedDetail));
    if (sections.length > 0) return new Text(`${line}\n${sections.join("\n")}`, 0, 0);
  }
  return new Text(line, 0, 0);
}

export function renderToolResult(theme: Theme, label: string, failed = false, partial = false): Text {
  return renderToolOutcome(theme, label, { isPartial: partial, expanded: false }, failed);
}
