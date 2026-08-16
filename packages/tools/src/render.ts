import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** Keep tool activity readable without copying model-facing payloads into the TUI. */
export function compactToolText(value: unknown, maxLength = 80): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  const withoutCredentials = text
    .replace(/(https?:\/\/)([^/@\s]+):([^/@\s]+)@/gi, "$1[redacted]@")
    .replace(/([?&](?:token|key|secret|code|state|password|authorization|credential)=)[^&#\s]+/gi, "$1[redacted]");
  const singleLine = withoutCredentials.replace(/[\u001b\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/** Render one user-facing activity line for a pi-c2 tool call. */
export function renderToolCall(theme: Theme, label: string, activity?: string): Text {
  const suffix = activity ? theme.fg("muted", ` ${compactToolText(activity)}`) : "";
  return new Text(theme.fg("toolTitle", theme.bold(label)) + suffix, 0, 0);
}

/** Render an identifier as a safe, compact activity detail. */
export function renderToolDetail(theme: Theme, label: string, value: unknown, maxLength = 96): Text {
  return renderToolCall(theme, label, compactToolText(value, maxLength));
}

/** Render a compact outcome without exposing the tool's model-facing result. */
export interface ToolRenderContextLike {
  readonly isError?: boolean;
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

export function renderToolResult(theme: Theme, label: string, failed = false, partial = false): Text {
  if (partial) return new Text(theme.fg("dim", "…"), 0, 0);
  const marker = failed ? "✗" : "✓";
  return new Text(theme.fg(failed ? "warning" : "success", `${marker} ${compactToolText(label, 120)}`), 0, 0);
}
