import { Text } from "@earendil-works/pi-tui";

function compact(value: unknown, maxLength = 80): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  const withoutCredentials = text
    .replace(/(https?:\/\/)([^/@\s]+):([^/@\s]+)@/gi, "$1[redacted]@")
    .replace(/([?&](?:token|key|secret|code|state|password|authorization|credential)=)[^&#\s]+/gi, "$1[redacted]");
  const singleLine = withoutCredentials.replace(/[\u001b\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1).trimEnd()}…`;
}

function failed(result: unknown, context: { isError?: boolean }): boolean {
  if (context.isError) return true;
  if (!result || typeof result !== "object") return false;
  const details = (result as { details?: unknown }).details;
  if (details && typeof details === "object") {
    const record = details as Record<string, unknown>;
    if (record.isError === true || typeof record.failure === "string" || record.success === false) return true;
  }
  const content = (result as { content?: unknown }).content;
  return Array.isArray(content) && content.some((block) =>
    Boolean(block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" && String((block as { text: string }).text).startsWith("Error:")),
  );
}

export function inheritedMcpRenderCall(name: string, label: string, theme: { fg(color: string, text: string): string; bold(text: string): string }): Text {
  return new Text(theme.fg("toolTitle", theme.bold(compact(label))) + theme.fg("muted", ` ${compact(name)}`), 0, 0);
}

export function inheritedMcpRenderResult(result: unknown, options: { isPartial: boolean }, theme: { fg(color: string, text: string): string }, context: { isError?: boolean }): Text {
  if (options.isPartial) return new Text(theme.fg("dim", "…"), 0, 0);
  const isFailed = failed(result, context);
  return new Text(theme.fg(isFailed ? "warning" : "success", isFailed ? "✗ MCP tool failed" : "✓ MCP tool complete"), 0, 0);
}
