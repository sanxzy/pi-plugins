import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTelegramChatTool } from "../src/registrations/telegram.ts";

function capture(deps: Parameters<typeof registerTelegramChatTool>[1] = {}) {
  let tool: any;
  registerTelegramChatTool({ registerTool(value: any) { tool = value; } } as unknown as ExtensionAPI, deps);
  return tool;
}

function context(cwd = "/tmp/project"): ExtensionContext {
  return { cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "root" } } as unknown as ExtensionContext;
}

test("user_telegram_chat refuses when the latest connection is not Telegram", async () => {
  const tool = capture({ canSend: () => false });
  const result = await tool.execute("call", { message: "hello" }, undefined, undefined, context());
  assert.equal(result.details.error, "connection_not_telegram");
  assert.match(result.content[0].text, /Error:/);
});

test("user_telegram_chat sends through the marker-gated seam and reports chunks", async () => {
  const tool = capture({
    canSend: () => true,
    send: async () => ({ ok: true, sent: 2, failed: 0 }),
  });
  const result = await tool.execute("call", { message: "hello" }, undefined, undefined, context());
  assert.deepEqual(result.details, { sent: true, message: "hello", chunks: 2 });
  assert.match(result.content[0].text, /2 messages/);
});

test("user_telegram_chat reports partial delivery explicitly", async () => {
  const tool = capture({
    canSend: () => true,
    send: async () => ({ ok: false, sent: 1, failed: 1, error: "second chunk failed" }),
  });
  const result = await tool.execute("call", { message: "hello" }, undefined, undefined, context());
  assert.deepEqual(result.details, {
    sent: false,
    message: "hello",
    sentChunks: 1,
    failedChunks: 1,
    error: "second chunk failed",
  });
  assert.match(result.content[0].text, /partial|failed/i);
});