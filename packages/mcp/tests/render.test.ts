import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { compactMcpLabel, renderMcpCall, renderMcpResult } from "../src/render.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function text(component: { render(width: number): string[] }): string {
  return stripVTControlCharacters(component.render(120).join("\n"));
}

const result = {
  content: [{ type: "text", text: "safe body\nhttps://user:password@example.com/?token=secret" }],
  details: { server: "demo", tool: "lookup", structuredContent: { answer: "safe body" } },
};

test("MCP renderers keep collapsed rows concise and expand safe payloads", () => {
  const call = text(renderMcpCall("lookup", "demo", theme));
  assert.match(call, /MCP lookup/);
  assert.match(call, /demo/);
  const expandedCall = text(renderMcpCall("lookup", "demo", theme, { expanded: true, args: { query: "find it" } }));
  assert.match(expandedCall, /\"query\"/);
  assert.match(expandedCall, /find it/);

  const collapsed = text(renderMcpResult("lookup", result, { expanded: false, isPartial: false }, theme, {}));
  assert.match(collapsed, /completed/);
  assert.doesNotMatch(collapsed, /safe body|password|secret/);

  const expanded = text(renderMcpResult("lookup", result, { expanded: true, isPartial: false }, theme, {}));
  assert.match(expanded, /safe body/);
  assert.match(expanded, /\[redacted\]/);
  assert.match(expanded, /\"server\"/);
  assert.match(expanded, /\"tool\"/);
  assert.match(expanded, /\"structuredContent\"/);
  assert.doesNotMatch(expanded, /password|token=secret/);
});

test("MCP error rows do not expose payload details", () => {
  const error = { content: [{ type: "text", text: "Error: private transport details" }], details: { isError: true, failure: "transport_error" } };
  const rendered = text(renderMcpResult("lookup", error, { expanded: true, isPartial: false }, theme, {}));
  assert.match(rendered, /failed/);
  assert.doesNotMatch(rendered, /private transport details/);
});

test("MCP expanded traces redact token and transport key variants", () => {
  const args = { access_token: "tok-secret", refreshToken: "refresh-secret", requestId: "req-secret", authorization: "Bearer abc.def" };
  const call = text(renderMcpCall("lookup", "demo", theme, { expanded: true, args }));
  assert.doesNotMatch(call, /tok-secret|refresh-secret|req-secret|abc\.def/);
  const rendered = text(renderMcpResult("lookup", { content: [{ type: "text", text: "safe access_token=tok-secret requestId=req-secret traceId=trace-secret client_secret=client-secret client_id=client-id api_secret=api-secret https://example.test/?client_secret=url-secret&client_id=url-id" }], details: args }, { expanded: true, isPartial: false }, theme, {}));
  assert.match(rendered, /safe/);
  assert.doesNotMatch(rendered, /tok-secret|refresh-secret|req-secret|trace-secret|abc\.def|client-secret|client-id|api-secret|url-secret|url-id/);
});

test("MCP labels sanitize credentials and terminal controls", () => {
  assert.equal(compactMcpLabel("\u001b[31mhttps://user:pass@example.com?token=secret\u001b[0m"), "https://[redacted]@example.com?token=[redacted]");
});
