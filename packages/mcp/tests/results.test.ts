import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeCallToolResult,
  boundedText,
} from "../src/results.ts";

test("normalizes MCP text and structured content into Pi tool results", () => {
  const result = normalizeCallToolResult({
    content: [{ type: "text", text: "hello" }],
    structuredContent: { answer: 42 },
    isError: false,
  }, { server: "demo", tool: "answer" });
  assert.deepEqual(result.content, [{ type: "text", text: "hello" }]);
  assert.deepEqual(result.details.structuredContent, { answer: 42 });
  assert.equal(result.details.isError, false);
  assert.equal(result.details.server, "demo");
  assert.equal(result.details.tool, "answer");
});

test("preserves supported MCP images and reports resources in details", () => {
  const result = normalizeCallToolResult({
    content: [
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "resource", resource: { uri: "file:///x", mimeType: "text/plain", text: "resource text" } },
    ],
  }, { server: "demo", tool: "mixed" });
  assert.deepEqual(result.content, [
    { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    { type: "text", text: "resource text" },
  ]);
  assert.equal(result.details.resources?.[0]?.uri, "file:///x");
});

test("bounds oversized text and unsupported or oversized resource content", () => {
  assert.equal(boundedText("abcdef", 3), "abc\n[output truncated]");
  const result = normalizeCallToolResult({
    content: [
      { type: "text", text: "abcdef" },
      { type: "resource", resource: { uri: "file:///blob", blob: "aGVsbG8=" } },
    ],
  }, { server: "demo", tool: "large", maxText: 3, maxAttachmentBytes: 2 });
  assert.equal(result.content[0]?.type, "text");
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /truncated/);
  assert.equal(result.content[1]?.type, "text");
  assert.match(result.content[1]?.type === "text" ? result.content[1].text : "", /omitted|unsupported|too large/i);
});

test("MCP tool errors remain distinguishable from transport failures", () => {
  const mcpError = normalizeCallToolResult({ content: [{ type: "text", text: "bad input" }], isError: true }, { server: "demo", tool: "bad" });
  assert.equal(mcpError.details.isError, true);
  assert.equal(mcpError.details.failure, "mcp_tool_error");
  const transport = normalizeCallToolResult(undefined, { server: "demo", tool: "bad", transportError: "connection lost" });
  assert.equal(transport.details.failure, "transport_error");
  assert.equal(transport.content[0]?.type, "text");
  assert.equal(transport.content[0]?.type === "text" ? transport.content[0].text : undefined, "Error: connection lost");
});

test("cancellation and policy denial have explicit bounded result status", () => {
  const cancelled = normalizeCallToolResult(undefined, { server: "demo", tool: "x", cancelled: true });
  assert.equal(cancelled.details.failure, "cancelled");
  const denied = normalizeCallToolResult(undefined, { server: "demo", tool: "x", policyDenied: true });
  assert.equal(denied.details.failure, "policy_denied");
});
