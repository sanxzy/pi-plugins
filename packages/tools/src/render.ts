import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** Keep tool activity readable without copying model-facing payloads into the TUI. */
export function compactToolText(value: unknown, maxLength = 80): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  const withoutCredentials = text
    .replace(/(https?:\/\/)([^/@\s]+):([^/@\s]+)@/gi, "$1[redacted]@")
    .replace(/([?&](?:token|key|secret|code|state|password|authorization|credential)=)[^&#\s]+/gi, "$1[redacted]")
    .replace(/(["'](?:chat[_-]?id|file[_-]?id|artifact[_-]?id|token|key|secret|code|state|password|authorization|credential|api[_-]?key)["']\s*:\s*)("[^"]*"|[^,}\s]+)/gi, '$1"[redacted]"')
    .replace(/(?:\bbot\d+:[A-Za-z0-9_-]+\b|\bchat[_-]?id\s*[:=]\s*["']?\d+["']?)/gi, "[redacted]");
  const singleLine = withoutCredentials.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/** Serialize a value for expanded tracing without letting unusual values break rendering. */
function traceValue(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, null, 2);
    return expandedToolText(serialized === undefined ? String(value ?? "") : serialized);
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

/** Serialize the result exactly as the model-facing tool boundary exposes it. */
export function toolResultTrace(
  result: { content?: unknown; details?: unknown } | undefined,
  context?: ToolRenderContextLike,
): string {
  try {
    return traceValue({
      content: result?.content ?? [],
      ...(result?.details === undefined ? {} : { details: result.details }),
      ...(context?.isError ? { isError: true } : {}),
    });
  } catch {
    return expandedToolText(String(result ?? ""));
  }
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
    .replace(/([?&](?:token|key|secret|code|state|password|authorization|credential)=)[^&#\s]+/gi, "$1[redacted]")
    .replace(/(["'](?:chat[_-]?id|file[_-]?id|artifact[_-]?id|token|key|secret|code|state|password|authorization|credential|api[_-]?key)["']\s*:\s*)("[^"]*"|[^,}\s]+)/gi, '$1"[redacted]"')
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
    return expandedToolText(JSON.stringify(structured, null, 2));
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
  if (options.expanded) {
    const sections: string[] = [];
    if (traceArgs !== undefined) sections.push(`Arguments:\n${traceValue(traceArgs)}`);
    if (traceResult) sections.push(`Result:\n${toolResultTrace(traceResult, { isError: failed })}`);
    else if (expandedDetail) sections.push(expandedToolText(expandedDetail));
    if (sections.length > 0) return new Text(`${line}\n${sections.join("\n")}`, 0, 0);
  }
  return new Text(line, 0, 0);
}

export function renderToolResult(theme: Theme, label: string, failed = false, partial = false): Text {
  return renderToolOutcome(theme, label, { isPartial: partial, expanded: false }, failed);
}
