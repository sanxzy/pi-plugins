import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { redactDiagnostic } from "./diagnostics.ts";

const DEFAULT_MAX_TEXT = 50_000;
const DEFAULT_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export interface NormalizedDetails {
  server: string;
  tool: string;
  isError: boolean;
  failure?: "mcp_tool_error" | "transport_error" | "cancelled" | "policy_denied";
  transportError?: string;
  structuredContent?: unknown;
  resources?: Array<{ uri?: string; mimeType?: string; omitted?: string }>;
  nativeIdentity: { server: string; tool: string };
}

export interface NormalizeContext {
  server: string;
  tool: string;
  maxText?: number;
  maxAttachmentBytes?: number;
  transportError?: string;
  cancelled?: boolean;
  policyDenied?: boolean;
}

export function boundedText(value: string, maxText = DEFAULT_MAX_TEXT): string {
  if (value.length <= maxText) return value;
  return `${value.slice(0, Math.max(0, maxText))}\n[output truncated]`;
}

function byteLengthBase64(value: string): number {
  return Math.floor(value.replace(/\s/g, "").length * 3 / 4);
}

/** Normalize MCP content blocks into Pi text/image content blocks. */
export function normalizeMcpContent(
  blocks: unknown,
  options: Pick<NormalizeContext, "maxText" | "maxAttachmentBytes">,
): { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; resources: NormalizedDetails["resources"] } {
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  const resources: NonNullable<NormalizedDetails["resources"]> = [];
  const maxText = options.maxText ?? DEFAULT_MAX_TEXT;
  const maxAttachmentBytes = options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;

  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (typeof block !== "object" || block === null) continue;
    const item = block as Record<string, unknown>;
    if (item.type === "text") {
      content.push({ type: "text", text: boundedText(typeof item.text === "string" ? item.text : "", maxText) });
      continue;
    }
    if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
      if (byteLengthBase64(item.data) <= maxAttachmentBytes) {
        content.push({ type: "image", data: item.data, mimeType: item.mimeType });
      } else {
        content.push({ type: "text", text: `[image omitted: attachment exceeds ${maxAttachmentBytes} bytes]` });
      }
      continue;
    }
    if (item.type === "resource" && typeof item.resource === "object" && item.resource !== null) {
      const resource = item.resource as Record<string, unknown>;
      const uri = typeof resource.uri === "string" ? resource.uri : undefined;
      const mimeType = typeof resource.mimeType === "string" ? resource.mimeType : undefined;
      resources.push({ uri, mimeType });
      if (typeof resource.text === "string") {
        content.push({ type: "text", text: boundedText(resource.text, maxText) });
      } else if (typeof resource.blob === "string" && mimeType?.startsWith("image/")) {
        if (byteLengthBase64(resource.blob) <= maxAttachmentBytes) {
          content.push({ type: "image", data: resource.blob, mimeType });
        } else {
          content.push({ type: "text", text: `[resource omitted: attachment exceeds ${maxAttachmentBytes} bytes]` });
          resources[resources.length - 1]!.omitted = "attachment too large";
        }
      } else {
        content.push({ type: "text", text: `[resource omitted: unsupported or binary resource${uri ? ` ${uri}` : ""}]` });
        resources[resources.length - 1]!.omitted = "unsupported";
      }
    }
  }
  return { content, resources };
}

/** Convert an MCP CallToolResult or transport/policy failure to a Pi result. */
export function normalizeCallToolResult(raw: unknown, context: NormalizeContext): AgentToolResult<NormalizedDetails> {
  const nativeIdentity = { server: context.server, tool: context.tool };
  if (context.policyDenied) {
    return {
      content: [{ type: "text", text: "Error: MCP tool call denied by policy" }],
      details: { ...nativeIdentity, nativeIdentity, isError: true, failure: "policy_denied" },
    };
  }
  if (context.cancelled) {
    return {
      content: [{ type: "text", text: "Error: MCP tool call cancelled" }],
      details: { ...nativeIdentity, nativeIdentity, isError: true, failure: "cancelled" },
    };
  }
  if (context.transportError) {
    const safe = boundedText(redactDiagnostic(context.transportError));
    return {
      content: [{ type: "text", text: `Error: ${safe}` }],
      details: { ...nativeIdentity, nativeIdentity, isError: true, failure: "transport_error", transportError: safe },
    };
  }

  const result = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const normalized = normalizeMcpContent(result.content, context);
  if (normalized.content.length === 0 && result.structuredContent !== undefined) {
    normalized.content.push({ type: "text", text: boundedText(JSON.stringify(result.structuredContent), context.maxText) });
  }
  if (normalized.content.length === 0) normalized.content.push({ type: "text", text: "MCP tool returned no content" });
  const isError = result.isError === true;
  const resources = normalized.resources ?? [];
  return {
    content: normalized.content,
    details: {
      ...nativeIdentity,
      nativeIdentity,
      isError,
      ...(isError ? { failure: "mcp_tool_error" as const } : {}),
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      ...(resources.length ? { resources } : {}),
    },
  };
}

export const RESULT_LIMITS = {
  maxText: DEFAULT_MAX_TEXT,
  maxAttachmentBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
} as const;
