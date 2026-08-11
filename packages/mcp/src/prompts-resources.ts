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
  isError: boolean;
  failure?: "mcp_error" | "transport_error" | "cancelled" | "policy_denied" | "unavailable";
  omitted?: string[];
}

const MAX_TEXT = 50_000;

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
  const result = (raw && typeof raw === "object" ? raw : {}) as { messages?: Array<{ role?: string; content?: unknown }> };
  const messages = (result.messages ?? []).map((message) => {
    const texts: string[] = [];
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        texts.push(bounded((block as { text?: string }).text));
      }
    }
    return { role: message.role ?? "user", text: texts.join("\n") };
  });
  return { server, prompt, messages, isError: false };
}

/** Flatten a read-resource result into bounded text plus omission notes. */
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
  const omitted: string[] = [];
  for (const content of result.contents ?? []) {
    if (typeof content.text === "string") {
      parts.push(bounded(content.text));
      continue;
    }
    if (typeof content.blob === "string") {
      const mime = typeof content.mimeType === "string" ? content.mimeType : "";
      if (mime.startsWith("image/")) {
        parts.push(`[image resource omitted; use a client that handles binary resources]`);
      } else {
        parts.push(`[binary resource omitted: ${content.uri ?? uri}]`);
      }
      omitted.push(content.uri ? String(content.uri) : uri);
      continue;
    }
    omitted.push(content.uri ? String(content.uri) : uri);
    parts.push(`[resource content omitted: unsupported type]`);
  }
  return { server, uri, text: parts.join("\n"), isError: false, ...(omitted.length ? { omitted } : {}) };
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
  return result.messages.map((m) => `${m.role}: ${m.text}`).join("\n") || "(no prompt output)";
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