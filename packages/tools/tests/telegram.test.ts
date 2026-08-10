import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTelegramChatTool } from "../src/registrations/telegram.ts";
import { telegramChatParams } from "../src/tools.ts";

function capture(deps: any = {}) {
  let tool: any;
  registerTelegramChatTool({ registerTool(value: any) { tool = value; } } as unknown as ExtensionAPI, deps);
  return tool;
}

function context(cwd = "/tmp/project"): ExtensionContext {
  return { cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "root", getBranch: () => [] } } as unknown as ExtensionContext;
}

const sendText = { action: "send_text", chat_id: "777", text: "hello" };

test("schema rejects legacy, actionless, and incomplete send_text payloads", () => {
  assert.equal(Value.Check(telegramChatParams, { message: "hello" }), false);
  assert.equal(Value.Check(telegramChatParams, { chat_id: "777", text: "hello" }), false);
  assert.equal(Value.Check(telegramChatParams, { action: "send_text", chat_id: "777" }), false);
  assert.equal(Value.Check(telegramChatParams, sendText), true);
});

test("schema rejects mixed-action and unknown fields on send_text", () => {
  assert.equal(Value.Check(telegramChatParams, { ...sendText, reaction: "👍" }), false);
  assert.equal(Value.Check(telegramChatParams, { ...sendText, choices: [] }), false);
  assert.equal(Value.Check(telegramChatParams, { ...sendText, message: "bye" }), false);
  assert.equal(Value.Check(telegramChatParams, { ...sendText, foo: "bar" }), false);
});

test("schema accepts rich text and delivery override fields", () => {
  assert.equal(Value.Check(telegramChatParams, { ...sendText, format: "plain" }), true);
  assert.equal(Value.Check(telegramChatParams, { ...sendText, format: "html", message_id: 42 }), true);
  assert.equal(Value.Check(telegramChatParams, {
    ...sendText,
    format: "markdown_v2",
    link_preview_options: { is_disabled: true },
    disable_notification: true,
  }), true);
  assert.equal(Value.Check(telegramChatParams, { ...sendText, format: "xml" }), false);
});

test("send_text with an approved chat sends and returns safe metadata", async () => {
  let target: string | undefined;
  const tool = capture({
    validateTarget: async () => ({ ok: true, chatId: "777" }),
    send: async (_root: string, chatId: string) => {
      target = chatId;
      return { ok: true, sent: 2, failed: 0, messageIds: [1, 2] };
    },
  });
  const result = await tool.execute("call", sendText, undefined, undefined, context());
  assert.equal(target, "777");
  assert.deepEqual(result.details, { action: "send_text", sent: true, chatId: "777", chunks: 2, messageIds: [1, 2] });
  assert.match(result.content[0].text, /2 messages/);
});

test("send_text forwards rich format and delivery overrides", async () => {
  let received: unknown;
  const tool = capture({
    validateTarget: async () => ({ ok: true, chatId: "777" }),
    send: async (_root: string, _chatId: string, _text: string, options: unknown) => {
      received = options;
      return { ok: true, sent: 1, failed: 0, messageIds: [9] };
    },
  });
  await tool.execute("call", {
    ...sendText,
    format: "html",
    message_id: 42,
    link_preview_options: { is_disabled: true },
    disable_notification: true,
  }, undefined, undefined, context());
  assert.deepEqual(received, {
    format: "html",
    messageId: 42,
    linkPreviewOptions: { is_disabled: true },
    disableNotification: true,
  });
});

test("send_text rejects an unapproved target before any send", async () => {
  let sent = false;
  const tool = capture({
    validateTarget: async () => ({ ok: false, category: "target_not_approved", error: "not approved" }),
    send: async () => {
      sent = true;
      return { ok: true, sent: 1, failed: 0, messageIds: [1] };
    },
  });
  const result = await tool.execute("call", sendText, undefined, undefined, context());
  assert.equal(sent, false);
  assert.equal(result.details.category, "target_not_approved");
  assert.match(result.content[0].text, /Error:/);
});

test("send_text reports partial delivery explicitly", async () => {
  const tool = capture({
    validateTarget: async () => ({ ok: true, chatId: "777" }),
    send: async () => ({ ok: false, sent: 1, failed: 1, error: "second chunk failed", category: "partial_delivery" }),
  });
  const result = await tool.execute("call", sendText, undefined, undefined, context());
  assert.equal(result.details.category, "partial_delivery");
  assert.equal(result.details.failedChunks, 1);
  assert.match(result.content[0].text, /Error:/);
});

test("send_text fails closed when the channel is not configured", async () => {
  const tool = capture({
    validateTarget: async () => ({ ok: false, category: "not_configured", error: "not configured" }),
  });
  const result = await tool.execute("call", sendText, undefined, undefined, context());
  assert.equal(result.details.category, "not_configured");
});
