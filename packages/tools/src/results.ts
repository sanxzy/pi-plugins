import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

/**
 * Shared tool-result helpers for the pi-code tool registrations.
 *
 * Every tool returns `AgentToolResult` with a text content block plus a
 * structured `details` payload the model can inspect.
 */

export function textResult<T>(text: string, details: T): AgentToolResult<T> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

export function errorResult<T>(text: string, details: T): AgentToolResult<T> {
  return textResult(`Error: ${text}`, details);
}
