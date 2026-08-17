import { Text } from "@earendil-works/pi-tui";

const SENSITIVE_KEY = /(?:^|[_-])(?:access|refresh|client|id|api)?[_-]?(?:token|secret|password|credential|key|authorization|auth|bearer|code|state)(?:$|[_-])|(?:^|[_-])client[_-]?id(?:$|[_-])|(?:^|[_-])(?:chat|file|artifact)[_-]?id(?:$|[_-])|(?:^|[_-])request[_-]?id(?:$|[_-])|(?:^|[_-])trace[_-]?id(?:$|[_-])/i;

function sensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase());
}

function sanitizeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return sanitizeExpanded(value);
  if (typeof value === "bigint") return `${value}n`;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, seen));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sensitiveKey(key) ? "[redacted]" : sanitizeValue(item, seen)]));
}

function compact(value: unknown, maxLength = 80): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  const singleLine = sanitizeExpanded(text).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1).trimEnd()}…`;
}

function sanitizeExpanded(value: string): string {
  return value
    .replace(/(https?:\/\/)([^/@\s]+):([^/@\s]+)@/gi, "$1[redacted]@")
    .replace(/([?&](?:token|key|secret|code|state|password|authorization|credential|access[_-]?token|refresh[_-]?token|client[_-]?(?:secret|id)|api[_-]?secret)=)[^&#\s]+/gi, "$1[redacted]")
    .replace(/(\b(?:bearer|basic)\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[redacted]")
    .replace(/(["'](?:chat[_-]?id|file[_-]?id|artifact[_-]?id|token|key|secret|code|state|password|authorization|credential|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?(?:secret|id)|api[_-]?secret|request[_-]?id|trace[_-]?id)["']\s*:\s*)("[^"]*"|[^,}\s]+)/gi, '$1"[redacted]"')
    .replace(/(\b(?:access[_-]?token|refresh[_-]?token|(?:api|auth|bearer)[_-]?(?:token|key)|client[_-]?(?:secret|id)|api[_-]?secret|token|secret|password|credential|authorization|request[_-]?id|trace[_-]?id|(?:chat|file|artifact)[_-]?id)\b\s*[=:]\s*)(?!\[redacted\])([^\s,;&}\]]+?)(?=[\s,;&}\]]|$)/gi, "$1[redacted]")
    .replace(/(\b(?:authorization|auth|bearer)\b\s*[=:]\s*)([^\r\n,;&}\]]+)/gi, "$1[redacted]")
    .replace(/(?:\bbot\d+:[A-Za-z0-9_-]+\b|\bchat[_-]?id\s*[:=]\s*["']?\d+["']?)/gi, "[redacted]")
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function projectContent(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((block): Array<Record<string, unknown>> => {
    if (!block || typeof block !== "object") return [];
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") return [{ type: "text", text: sanitizeExpanded(record.text) }];
    if (record.type === "image" && typeof record.mimeType === "string") return [{ type: "image", mimeType: record.mimeType }];
    return [];
  });
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
  try { return structured === undefined ? "" : JSON.stringify(sanitizeValue(structured), null, 2) ?? ""; } catch { return ""; }
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
    try { args = JSON.stringify(sanitizeValue(context.args), null, 2) ?? ""; } catch { args = sanitizeExpanded(String(context.args)); }
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
    if (result !== null && typeof result === "object" && !Array.isArray(result)) {
      const record = result as { content?: unknown; details?: unknown };
      const projectedContent = projectContent(record.content);
      if (projectedContent.length > 0) payload = JSON.stringify(projectedContent, null, 2) ?? "";
      else if (record.details && typeof record.details === "object" && "structuredContent" in record.details) payload = JSON.stringify(sanitizeValue((record.details as { structuredContent?: unknown }).structuredContent), null, 2) ?? "";
      else {
        const visible = Object.fromEntries(Object.entries(record.details && typeof record.details === "object" ? record.details : {}).filter(([key]) => ["answer", "message"].includes(key)));
        payload = JSON.stringify(sanitizeValue(visible), null, 2) ?? "";
      }
    }
  } catch {
    payload = expandedPayload(result);
  }
  return new Text(payload ? `${line}\n${payload}` : line, 0, 0);
}
