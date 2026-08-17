import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const SENSITIVE_KEY = /(?:^|[_-])(?:access|refresh|client|id|api)?[_-]?(?:token|secret|password|credential|key|authorization|auth|bearer|code|state)(?:$|[_-])|(?:^|[_-])client[_-]?id(?:$|[_-])|(?:^|[_-])(?:chat|file|artifact)[_-]?id(?:$|[_-])|(?:^|[_-])request[_-]?id(?:$|[_-])|(?:^|[_-])trace[_-]?id(?:$|[_-])/i;

function sensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase());
}

function humanValue(value: unknown, seen = new WeakSet<object>()): string {
  if (typeof value === "string") return expandedToolText(value).replace(/[\r\n]+/g, " ").trim();
  if (typeof value === "bigint") return `${value}n`;
  if (value === null || value === undefined) return "none";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => humanValue(item, seen)).join(", ");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "none";
  return entries.map(([key, item]) => `${key}=${sensitiveKey(key) ? "[redacted]" : humanValue(item, seen)}`).join(", ");
}

function humanInput(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length === 0 ? "none" : entries.map(([key, item]) => `${key}=${sensitiveKey(key) ? "[redacted]" : humanValue(item)}`).join(", ");
  }
  return humanValue(value);
}

function humanText(value: string, preserveText = false): string {
  const sanitized = expandedToolText(value);
  if (preserveText) return sanitized;
  const trimmed = sanitized.trim();
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && (trimmed.endsWith("}") || trimmed.endsWith("]"))) {
    try {
      return humanValue(JSON.parse(trimmed));
    } catch {
      // Preserve ordinary text that merely begins with a brace or bracket.
    }
  }
  return sanitized;
}

/** Keep tool activity readable without copying model-facing payloads into the TUI. */
export function compactToolText(value: unknown, maxLength = 80): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  const singleLine = expandedToolText(text).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
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
    return new Text(`${line}\nInput: ${humanInput(traceArgs)}`, 0, 0);
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

/** Format only the result content that is delivered to the model. */
export function toolResultTrace(
  result: { content?: unknown; details?: unknown } | undefined,
  _context?: ToolRenderContextLike,
): string {
  const content = Array.isArray(result?.content) ? result.content : [];
  const details = result?.details && typeof result.details === "object" ? result.details as Record<string, unknown> : undefined;
  const preserveText = details?.mode === "wikis" && typeof details.page === "object" && details.page !== null;
  const text = content
    .filter((block): block is Record<string, unknown> => Boolean(block && typeof block === "object" && (block as Record<string, unknown>).type === "text"))
    .filter((block) => typeof block.text === "string")
    .map((block) => humanText(block.text as string, preserveText))
    .join("\n");
  if (text) return text;
  if (result?.details && typeof result.details === "object") {
    const visible = Object.fromEntries(Object.entries(result.details).filter(([key]) => ["answer", "message"].includes(key)));
    if (Object.keys(visible).length > 0) return humanValue(visible);
    if ("structuredContent" in result.details) {
      const structured = (result.details as { structuredContent?: unknown }).structuredContent;
      return structured === undefined ? "" : humanValue(structured);
    }
  }
  return "";
}

function toolResultHasImage(result: { content?: unknown } | undefined): boolean {
  return Array.isArray(result?.content) && result.content.some((block) =>
    Boolean(block && typeof block === "object" && (block as Record<string, unknown>).type === "image" &&
      typeof (block as Record<string, unknown>).data === "string" &&
      typeof (block as Record<string, unknown>).mimeType === "string"),
  );
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
  readonly successMarker?: boolean;
  readonly expandedLabel?: boolean;
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
    return humanValue(structured);
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
  const marker = failed ? "✗" : options.successMarker === false ? "" : "✓";
  const prefix = marker ? `${marker} ` : "";
  const line = theme.fg(failed ? "warning" : "success", `${prefix}${compactToolText(label, 160)}`);
  if (options.expanded && !failed) {
    const sections: string[] = [];
    const resultText = traceResult ? toolResultTrace(traceResult) : expandedToolText(expandedDetail);
    if (resultText || (traceResult && toolResultHasImage(traceResult))) {
      sections.push(`Results:${resultText ? `\n${resultText}` : ""}`);
    }
    if (sections.length > 0) return new Text(`${options.expandedLabel === false ? "" : `${line}\n`}${sections.join("\n")}`, 0, 0);
  }
  return new Text(line, 0, 0);
}

export function renderToolResult(theme: Theme, label: string, failed = false, partial = false): Text {
  return renderToolOutcome(theme, label, { isPartial: partial, expanded: false }, failed);
}
