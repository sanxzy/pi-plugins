import { Text } from "@earendil-works/pi-tui";

type RenderTheme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

export type McpRenderContext = { isError?: boolean };

function compact(value: unknown, maxLength = 96): string {
  const text = String(value ?? "")
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/(https?:\/\/)([^/@\s]+):([^/@\s]+)@/gi, "$1[redacted]@")
    .replace(/([?&](?:token|key|secret|code|state|password|authorization|credential)=)[^&#\s]+/gi, "$1[redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function payloadText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const record = result as { content?: unknown; details?: unknown };
  const blocks = Array.isArray(record.content) ? record.content : [];
  const content = blocks
    .filter((block): block is Record<string, unknown> => Boolean(block && typeof block === "object"))
    .map((block) => {
      if (typeof block.text === "string") return block.text;
      if (block.type === "image" && typeof block.mimeType === "string") return `[image: ${block.mimeType}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
  if (content) return sanitizePayload(content);
  const details = record.details;
  if (details && typeof details === "object" && "structuredContent" in details) {
    try {
      return sanitizePayload(JSON.stringify((details as { structuredContent?: unknown }).structuredContent, null, 2));
    } catch {
      return "";
    }
  }
  return "";
}

function sanitizePayload(value: string): string {
  return value
    .replace(/(https?:\/\/)([^/@\s]+):([^/@\s]+)@/gi, "$1[redacted]@")
    .replace(/([?&](?:token|key|secret|code|state|password|authorization|credential)=)[^&#\s]+/gi, "$1[redacted]")
    .replace(/(\b(?:bot\d+:[A-Za-z0-9_-]+|chat[_-]?id\s*[:=]\s*)\d+\b)/gi, "[redacted]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\u001b/g, "");
}

function failed(result: unknown, context: McpRenderContext): boolean {
  if (context.isError) return true;
  if (!result || typeof result !== "object") return false;
  const details = (result as { details?: unknown }).details;
  if (details && typeof details === "object") {
    const record = details as Record<string, unknown>;
    if (record.isError === true || typeof record.failure === "string" || record.denied === true || record.unknown === true) return true;
  }
  return payloadText(result).trimStart().startsWith("Error:");
}

export function renderMcpCall(toolName: string, serverName: string, theme: RenderTheme): Text {
  return new Text(
    theme.fg("toolTitle", theme.bold(`MCP ${compact(toolName)}`)) + theme.fg("muted", ` • ${compact(serverName)}`),
    0,
    0,
  );
}

export function renderMcpResult(
  toolName: string,
  result: unknown,
  options: { expanded: boolean; isPartial: boolean },
  theme: RenderTheme,
  context: McpRenderContext,
): Text {
  if (options.isPartial) return new Text(theme.fg("dim", "…"), 0, 0);
  const isFailed = failed(result, context);
  const label = `MCP ${compact(toolName)} • ${isFailed ? "failed" : "completed"}`;
  const line = theme.fg(isFailed ? "warning" : "success", `${isFailed ? "✗" : "✓"} ${label}`);
  const payload = !isFailed && options.expanded ? payloadText(result) : "";
  return new Text(payload ? `${line}\n${payload}` : line, 0, 0);
}

export function mcpPayloadText(result: unknown): string {
  return payloadText(result);
}

export function mcpResultFailed(result: unknown, context: McpRenderContext): boolean {
  return failed(result, context);
}

export function compactMcpLabel(value: unknown): string {
  return compact(value);
}
