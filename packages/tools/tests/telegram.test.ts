import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTelegramChatTool, resolveTelegramChatFromSession } from "../src/registrations/telegram.ts";

function capture(deps: Parameters<typeof registerTelegramChatTool>[1] = {}) {
  let tool: any;
  registerTelegramChatTool({ registerTool(value: any) { tool = value; } } as unknown as ExtensionAPI, deps);
  return tool;
}

function context(cwd = "/tmp/project", entries: unknown[] = []): ExtensionContext {
  return { cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "root", getBranch: () => entries } } as unknown as ExtensionContext;
}

test("user_telegram_chat refuses when the latest user message is not Telegram", async () => {
  const tool = capture();
  const result = await tool.execute("call", { message: "hello" }, undefined, undefined, context());
  assert.equal(result.details.error, "connection_not_telegram");
  assert.match(result.content[0].text, /Error:/);
});

test("user_telegram_chat sends to the Telegram chat resolved from the latest user message", async () => {
  let target: string | undefined;
  const tool = capture({
    send: async (_root, chatId) => {
      target = chatId;
      return { ok: true, sent: 2, failed: 0 };
    },
  });
  const result = await tool.execute("call", { message: "hello" }, undefined, undefined, context("/tmp/project", [{
    type: "message",
    message: { role: "user", content: "hello\n\n---\n[from:telegram:777]\n---" },
  }]));
  assert.equal(target, "777");
  assert.deepEqual(result.details, { sent: true, message: "hello", chunks: 2 });
  assert.match(result.content[0].text, /2 messages/);
});

test("user_telegram_chat reports partial delivery explicitly", async () => {
  const tool = capture({
    resolveChat: () => "777",
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

test("resolveTelegramChatFromSession uses the latest user message only", () => {
  const ctx = context("/tmp/project", [
    { type: "message", message: { role: "user", content: "old\n[from:telegram:111]" } },
    { type: "message", message: { role: "assistant", content: [] } },
    { type: "message", message: { role: "user", content: "new TUI prompt" } },
  ]);
  assert.equal(resolveTelegramChatFromSession(ctx), undefined);
});