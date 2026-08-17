import { Text } from "@earendil-works/pi-tui";

function compact(value: unknown, maxLength = 80): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  const withoutCredentials = text
    .replace(/(https?:\/\/)([^/@\s]+):([^/@\s]+)@/gi, "$1[redacted]@")
    .replace(/([?&](?:token|key|secret|code|state|password|authorization|credential)=)[^&#\s]+/gi, "$1[redacted]");
  const singleLine = withoutCredentials.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1).trimEnd()}…`;
}

function sanitizeExpanded(value: string): string {
  return value
    .replace(/(https?:\/\/)([^/@\s]+):([^/@\s]+)@/gi, "$1[redacted]@")
    .replace(/([?&](?:token|key|secret|code|state|password|authorization|credential)=)[^&#\s]+/gi, "$1[redacted]")
    .replace(/(["'](?:chat[_-]?id|file[_-]?id|artifact[_-]?id|token|key|secret|code|state|password|authorization|credential|api[_-]?key)["']\s*:\s*)("[^"]*"|[^,}\s]+)/gi, '$1"[redacted]"')
    .replace(/(?:\bbot\d+:[A-Za-z0-9_-]+\b|\bchat[_-]?id\s*[:=]\s*["']?\d+["']?)/gi, "[redacted]")
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "");
}

function expandedPayload(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const record = result as { content?: unknown; details?: unknown };
  const content = Array.isArray(record.content)
    ? record.content.map((block) => {
      if (!block || typeof block !== "object") return "";
      const item = block as { text?: unknown; type?: unknown; mimeType?: unknown };
      if (typeof item.text === "string") return item.text;
      if (item.type === "image" && typeof item.mimeType === "string") return `[image: ${item.mimeType}]`;
      return "";
    }).filter(Boolean).join("\n")
    : "";
  if (content) return sanitizeExpanded(content);
  const structured = record.details && typeof record.details === "object" && "structuredContent" in record.details
    ? (record.details as { structuredContent?: unknown }).structuredContent
    : undefined;
  try { return structured === undefined ? "" : sanitizeExpanded(JSON.stringify(structured, null, 2)); } catch { return ""; }
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

export function inheritedMcpRenderCall(name: string, label: string, theme: { fg(color: string, text: string): string; bold(text: string): string }, context?: { expanded?: boolean; args?: unknown }): Text {
  const line = theme.fg("toolTitle", theme.bold(compact(label))) + theme.fg("muted", ` ${compact(name)}`);
  if (context?.expanded && context.args !== undefined) {
    let args = "";
    try { args = sanitizeExpanded(JSON.stringify(context.args, null, 2)); } catch { args = sanitizeExpanded(String(context.args)); }
    return new Text(`${line}\nArguments:\n${args}`, 0, 0);
  }
  return new Text(line, 0, 0);
}

export function inheritedMcpRenderResult(result: unknown, options: { expanded?: boolean; isPartial: boolean }, theme: { fg(color: string, text: string): string }, context: { isError?: boolean }): Text {
  if (options.isPartial) return new Text(theme.fg("dim", "…"), 0, 0);
  const isFailed = failed(result, context);
  const line = theme.fg(isFailed ? "warning" : "success", isFailed ? "✗ MCP tool failed" : "✓ MCP tool complete");
  if (isFailed || !options.expanded) return new Text(line, 0, 0);
  let payload = "";
  try {
    payload = sanitizeExpanded(JSON.stringify(result, null, 2));
  } catch {
    payload = expandedPayload(result);
  }
  return new Text(payload ? `${line}\n${payload}` : line, 0, 0);
}
