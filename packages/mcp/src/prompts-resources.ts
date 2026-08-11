import type {
  GetPromptResult,
  Prompt,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Result payloads for prompt and resource operations. */
export interface McpPromptResult {
  server: string;
  prompt: string;
  messages: Array<{ role: string; text: string }>;
  isError: boolean;
  failure?: "mcp_error" | "transport_error" | "cancelled" | "policy_denied" | "unavailable";
  missing?: string[];
}

export interface McpResourceResult {
  server: string;
  uri: string;
  text: string;
  content?: ResourceContentBlock[];
  isError: boolean;
  failure?: "mcp_error" | "transport_error" | "cancelled" | "policy_denied" | "unavailable";
  omitted?: string[];
}

const MAX_TEXT = 50_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface ResourceContentBlock {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

function bounded(value: string | undefined): string {
  if (!value) return "";
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}\n[output truncated]` : value;
}

/** Flatten a prompt result's messages into bounded text/content. */
export function normalizePromptResult(
  server: string,
  prompt: string,
  raw: unknown,
  context: { cancelled?: boolean; transportError?: string; policyDenied?: boolean; unavailable?: boolean } = {},
): McpPromptResult {
  if (context.policyDenied) {
    return { server, prompt, messages: [], isError: true, failure: "policy_denied" };
  }
  if (context.cancelled) {
    return { server, prompt, messages: [], isError: true, failure: "cancelled" };
  }
  if (context.unavailable) {
    return { server, prompt, messages: [], isError: true, failure: "unavailable" };
  }
  if (context.transportError) {
    return { server, prompt, messages: [], isError: true, failure: "transport_error" };
  }
  const result = (raw && typeof raw === "object" ? raw : {}) as {
    messages?: Array<{ role?: string; content?: unknown }>
  };
  const messages = (result.messages ?? []).map((message) => {
    const block = message.content;
    const text = block && typeof block === "object" && (block as { type?: string }).type === "text"
      ? bounded((block as { text?: string }).text)
      : "";
    return { role: message.role ?? "user", text };
  });
  return { server, prompt, messages, isError: false };
}

/** Flatten a read-resource result into bounded text/images plus omission notes. */
export function normalizeResourceResult(
  server: string,
  uri: string,
  raw: unknown,
  context: { cancelled?: boolean; transportError?: string; policyDenied?: boolean; unavailable?: boolean } = {},
): McpResourceResult {
  if (context.policyDenied) {
    return { server, uri, text: "", isError: true, failure: "policy_denied" };
  }
  if (context.cancelled) {
    return { server, uri, text: "", isError: true, failure: "cancelled" };
  }
  if (context.unavailable) {
    return { server, uri, text: "", isError: true, failure: "unavailable" };
  }
  if (context.transportError) {
    return { server, uri, text: "", isError: true, failure: "transport_error" };
  }
  const result = (raw && typeof raw === "object" ? raw : {}) as { contents?: Array<Record<string, unknown>> };
  const parts: string[] = [];
  const contentBlocks: ResourceContentBlock[] = [];
  const omitted: string[] = [];
  let total = 0;
  let truncated = false;
  const push = (part: string): void => {
    if (truncated || total >= MAX_TEXT) {
      truncated = true;
      return;
    }
    const separator = parts.length > 0 ? 1 : 0;
    const available = MAX_TEXT - total - separator;
    if (available <= 0) {
      truncated = true;
      return;
    }
    const marker = "\n[output truncated]";
    if (part.length > available) {
      const bodyLimit = Math.max(0, available - marker.length);
      parts.push(`${part.slice(0, bodyLimit)}${marker}`);
      total = MAX_TEXT;
      truncated = true;
      return;
    }
    parts.push(part);
    total += separator + part.length;
  };
  for (const content of result.contents ?? []) {
    if (typeof content.text === "string") {
      push(content.text);
      contentBlocks.push({ type: "text", text: bounded(content.text) });
      continue;
    }
    if (typeof content.blob === "string") {
      const mime = typeof content.mimeType === "string" ? content.mimeType : "";
      if (mime.startsWith("image/")) {
        const bytes = Math.floor(content.blob.replace(/\s/g, "").length * 3 / 4);
        if (bytes > MAX_IMAGE_BYTES) {
          push(`[image omitted: attachment exceeds ${MAX_IMAGE_BYTES} bytes]`);
          omitted.push(content.uri ? String(content.uri) : uri);
        } else {
          push(`[image: ${mime} ${content.uri ?? uri}]`);
          contentBlocks.push({ type: "image", data: content.blob, mimeType: mime });
        }
      } else {
        push(`[binary resource omitted: ${content.uri ?? uri}]`);
        omitted.push(content.uri ? String(content.uri) : uri);
      }
      continue;
    }
    omitted.push(content.uri ? String(content.uri) : uri);
    push("[resource content omitted: unsupported type]");
  }
  return { server, uri, text: parts.join("\n"), content: contentBlocks, isError: false, ...(omitted.length ? { omitted } : {}) };
}

function limit(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max))}\n[output truncated]`;
}

/** Build a bounded text message for command output. */
export function promptResultToText(result: McpPromptResult): string {
  if (result.isError) {
    const reason =
      result.failure === "policy_denied"
        ? "MCP prompt denied by policy"
        : result.failure === "cancelled"
          ? "MCP prompt cancelled"
          : result.failure === "unavailable"
            ? "MCP prompt is unavailable (server disconnected or removed)"
            : result.failure === "transport_error"
              ? "MCP prompt failed: transport error"
              : "MCP prompt error";
    return `Error: ${reason}`;
  }
  const joined = result.messages.map((m) => `${m.role}: ${m.text}`).join("\n");
  return joined ? limit(joined, MAX_TEXT) : "(no prompt output)";
}

export function resourceResultToText(result: McpResourceResult): string {
  if (result.isError) {
    const reason =
      result.failure === "policy_denied"
        ? "MCP resource denied by policy"
        : result.failure === "cancelled"
          ? "MCP resource read cancelled"
          : result.failure === "unavailable"
            ? "MCP resource is unavailable (server disconnected or removed)"
            : result.failure === "transport_error"
              ? "MCP resource read failed: transport error"
              : "MCP resource read error";
    return `Error: ${reason}`;
  }
  return result.text || "(resource is empty)";
}

export type { Client, CallToolResult, Prompt, Resource, ResourceTemplate, GetPromptResult, ReadResourceResult };