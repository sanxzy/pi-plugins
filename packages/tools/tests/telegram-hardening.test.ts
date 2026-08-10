import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTelegramChatTool } from "../src/registrations/telegram.ts";

function capture(deps: Record<string, unknown> = {}) {
  let tool: any;
  registerTelegramChatTool({ registerTool(value: any) { tool = value; } } as unknown as ExtensionAPI, deps);
  return tool;
}

function context(): ExtensionContext {
  return {
    cwd: "/tmp/project",
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionId: () => "root", getBranch: () => [] },
  } as unknown as ExtensionContext;
}

test("the unified tool completes all four supported actions through one boundary", async () => {
  const calls: string[] = [];
  const tool = capture({
    validateTarget: async () => ({ ok: true, chatId: "777" }),
    send: async () => { calls.push("send_text"); return { ok: true, sent: 1, failed: 0, messageIds: [1] }; },
    react: async () => { calls.push("react"); return { ok: true, sent: 1, failed: 0, messageIds: [2] }; },
    sendChoices: async () => { calls.push("send_choices"); return { ok: true, messageId: 3, expiresAt: 123 }; },
    sendMedia: async () => { calls.push("send_media"); return { ok: true, messageId: 4, bytes: 5, mediaType: "photo", filename: "x.jpg" }; },
  });
  const ctx = context();
  const results = await Promise.all([
    tool.execute("1", { action: "send_text", chat_id: "777", text: "hello" }, undefined, undefined, ctx),
    tool.execute("2", { action: "react", chat_id: "777", message_id: 2, emoji: "👍" }, undefined, undefined, ctx),
    tool.execute("3", { action: "send_choices", chat_id: "777", question: "Proceed?", choices: [{ label: "Yes", value: "y" }, { label: "No", value: "n" }] }, undefined, undefined, ctx),
    tool.execute("4", { action: "send_media", chat_id: "777", media_type: "photo", source: { kind: "file_id", file_id: "AgAD_file" } }, undefined, undefined, ctx),
  ]);
  assert.deepEqual(calls.sort(), ["react", "send_choices", "send_media", "send_text"]);
  assert.deepEqual(results.map((result: any) => result.details.sent), [true, true, true, true]);
  assert.deepEqual(results.map((result: any) => result.details.chatId), ["777", "777", "777", "777"]);
});

test("model-visible Telegram failures redact bot tokens and credential-bearing URLs", async () => {
  const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWX";
  const tool = capture({
    validateTarget: async () => ({ ok: true, chatId: "777" }),
    sendMedia: async () => ({
      ok: false,
      error: `upload failed for ${token}; source=https://example.com/file?token=${token}&secret=abc`,
      category: "network_error",
    }),
  });
  const result = await tool.execute("call", {
    action: "send_media", chat_id: "777", media_type: "document",
    source: { kind: "file_id", file_id: "AgAD_file" },
  }, undefined, undefined, context());
  const serialized = JSON.stringify({ content: result.content, details: result.details });
  assert.doesNotMatch(serialized, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(serialized, /token=123456789/);
  assert.doesNotMatch(serialized, /secret=abc/);
  assert.match(serialized, /network_error/);
});

test("malformed runtime action data fails closed instead of reaching an outbound seam", async () => {
  let called = false;
  const tool = capture({
    validateTarget: async () => ({ ok: true, chatId: "777" }),
    send: async () => { called = true; return { ok: true, sent: 1, failed: 0, messageIds: [1] }; },
  });
  const result = await tool.execute("call", { action: "send_photo", chat_id: "777", text: "bad" }, undefined, undefined, context());
  assert.equal(called, false);
  assert.equal(result.details.sent, false);
  assert.equal(result.details.category, "telegram_rejected");
});
