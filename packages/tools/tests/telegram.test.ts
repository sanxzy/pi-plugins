import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTelegramChatTool, createTelegramChatAdapter } from "../src/registrations/telegram.ts";
import { telegramChatParams } from "../src/tools.ts";
import { createChannelChatRegistry } from "@xzy-ai/channels";

function capture(deps: any = {}) {
  let tool: any;
  registerTelegramChatTool({ registerTool(value: any) { tool = value; } } as unknown as ExtensionAPI, {
    ...deps,
    registry: deps.registry ?? createChannelChatRegistry([]),
  });
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
  assert.equal(Value.Check(telegramChatParams, { ...sendText, channel: "telegram" }), false);
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

test("schema accepts explicit send_choices action and rejects invalid choices", () => {
  assert.equal(Value.Check(telegramChatParams, {
    action: "send_choices", chat_id: "777", question: "Proceed?",
    choices: [{ label: "Yes", value: "y" }, { label: "No", value: "n" }],
  }), true);
  assert.equal(Value.Check(telegramChatParams, {
    action: "send_choices", chat_id: "777", question: "Proceed?", choices: [{ label: "Yes" }],
  }), false, "choices need at least two and each needs a value");
  assert.equal(Value.Check(telegramChatParams, {
    action: "send_choices", chat_id: "777", question: "Proceed?",
    choices: [{ label: "A", value: "a" }, { label: "A", value: "a" }], message_id: 5,
  }), true, "reply message_id is allowed");
});

test("schema accepts explicit send_media photo/document sources and rejects unsafe forms", () => {
  assert.equal(Value.Check(telegramChatParams, {
    action: "send_media", chat_id: "777", media_type: "photo",
    source: { kind: "file_id", file_id: "AgAD_file" }, caption: "hi",
  }), true);
  assert.equal(Value.Check(telegramChatParams, {
    action: "send_media", chat_id: "777", media_type: "document",
    source: { kind: "artifact_id", artifact_id: "artifact-1" }, filename: "report.pdf",
  }), true);
  assert.equal(Value.Check(telegramChatParams, {
    action: "send_media", chat_id: "777", media_type: "document",
    source: { kind: "https", url: "https://example.com/report.pdf" },
  }), true);
  assert.equal(Value.Check(telegramChatParams, {
    action: "send_media", chat_id: "777", media_type: "video",
    source: { kind: "file_id", file_id: "AgAD_file" },
  }), false);
  assert.equal(Value.Check(telegramChatParams, {
    action: "send_media", chat_id: "777", media_type: "photo",
    source: { kind: "path", path: "/tmp/photo.jpg" },
  }), false);
  assert.equal(Value.Check(telegramChatParams, {
    action: "send_media", chat_id: "777", media_type: "photo",
    source: { kind: "https", url: "http://example.com/photo.jpg" },
  }), true, "URL syntax is schema-valid; HTTPS policy is enforced before upload");
});

test("schema accepts explicit standard react action and rejects custom reactions", () => {
  assert.equal(Value.Check(telegramChatParams, { action: "react", chat_id: "777", message_id: 42, emoji: "👍" }), true);
  assert.equal(Value.Check(telegramChatParams, { action: "react", chat_id: "777", message_id: 42, emoji: "custom" }), false);
  assert.equal(Value.Check(telegramChatParams, { action: "react", chat_id: "777", message_id: 0, emoji: "👍" }), false);
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
  assert.deepEqual(result.details, { action: "send_text", sent: true, chatId: "777", message: "hello", chunks: 2, messageIds: [1, 2] });
  assert.match(result.content[0].text, /2 messages/);
});

test("react action applies a supported emoji and returns target metadata", async () => {
  let received: unknown;
  const tool = capture({
    validateTarget: async () => ({ ok: true, chatId: "777" }),
    react: async (_root: string, chatId: string, messageId: number, emoji: string) => {
      received = { chatId, messageId, emoji };
      return { ok: true, sent: 1, failed: 0, messageIds: [messageId] };
    },
  });
  const result = await tool.execute("call", { action: "react", chat_id: "777", message_id: 42, emoji: "👍" }, undefined, undefined, context());
  assert.deepEqual(received, { chatId: "777", messageId: 42, emoji: "👍" });
  assert.deepEqual(result.details, { action: "react", sent: true, chatId: "777", messageId: 42, emoji: "👍" });
});

test("react rejects invalid target or emoji before the reaction API", async () => {
  let called = false;
  const tool = capture({
    validateTarget: async () => ({ ok: true, chatId: "777" }),
    react: async () => {
      called = true;
      return { ok: true, sent: 1, failed: 0, messageIds: [42] };
    },
  });
  const result = await tool.execute("call", { action: "react", chat_id: "777", message_id: 42, emoji: "custom" }, undefined, undefined, context());
  assert.equal(called, false);
  assert.equal(result.details.category, "telegram_rejected");
});

test("send_media forwards a file_id and returns safe metadata", async () => {
  let received: unknown;
  const tool = capture({
    validateTarget: async () => ({ ok: true, chatId: "777" }),
    sendMedia: async (_root: string, chatId: string, mediaType: string, source: unknown, options: unknown) => {
      received = { chatId, mediaType, source, options };
      return { ok: true, messageId: 301, bytes: 123, mediaType: "photo", filename: undefined };
    },
  });
  const result = await tool.execute("call", {
    action: "send_media", chat_id: "777", media_type: "photo",
    source: { kind: "file_id", file_id: "AgAD_file" }, caption: "hello",
  }, undefined, undefined, context());
  assert.deepEqual(received, {
    chatId: "777", mediaType: "photo", source: { kind: "file_id", file_id: "AgAD_file" }, options: { caption: "hello", filename: undefined },
  });
  assert.deepEqual(result.details, { action: "send_media", sent: true, chatId: "777", messageId: 301, mediaType: "photo", bytes: 123 });
});

test("send_media rejects an unsafe source before delivery", async () => {
  let called = false;
  const tool = capture({
    validateTarget: async () => ({ ok: true, chatId: "777" }),
    sendMedia: async () => { called = true; return { ok: true, messageId: 1, bytes: 1, mediaType: "photo" }; },
  });
  const result = await tool.execute("call", {
    action: "send_media", chat_id: "777", media_type: "photo",
    source: { kind: "path", path: "/etc/passwd" },
  }, undefined, undefined, context());
  assert.equal(called, false);
  assert.equal(result.details.category, "telegram_rejected");
});

test("send_choices rejects duplicate labels or values before delivery", async () => {
  let sent = false;
  const tool = capture({
    validateTarget: async () => ({ ok: true, chatId: "777" }),
    sendChoices: async () => {
      sent = true;
      return { ok: true, messageId: 200, expiresAt: 1234 };
    },
  });
  const result = await tool.execute("call", {
    action: "send_choices", chat_id: "777", question: "Proceed?",
    choices: [{ label: "Yes", value: "same" }, { label: "No", value: "same" }],
  }, undefined, undefined, context());
  assert.equal(sent, false);
  assert.equal(result.details.category, "telegram_rejected");
});

test("send_choices forwards choices and returns safe prompt metadata", async () => {
  let received: unknown;
  const tool = capture({
    validateTarget: async () => ({ ok: true, chatId: "777" }),
    sendChoices: async (_root: string, chatId: string, question: string, choices: unknown[]) => {
      received = { chatId, question, choices };
      return { ok: true, messageId: 200, expiresAt: 1234 };
    },
  });
  const result = await tool.execute("call", {
    action: "send_choices", chat_id: "777", question: "Proceed?",
    choices: [{ label: "Yes", value: "y" }, { label: "No", value: "n" }],
  }, undefined, undefined, context());
  assert.deepEqual(received, {
    chatId: "777", question: "Proceed?",
    choices: [{ label: "Yes", value: "y" }, { label: "No", value: "n" }],
  });
  assert.deepEqual(result.details, {
    action: "send_choices", sent: true, chatId: "777", question: "Proceed?",
    messageId: 200, expiresAt: 1234,
  });
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

test("the telegram adapter and registry support future channel adapters", async () => {
  const adapter = createTelegramChatAdapter({ send: async () => ({ ok: true, sent: 1, failed: 0, messageIds: [7] }) });
  assert.equal(adapter.id, "telegram");
  assert.equal(adapter.label, "Telegram");
  const custom = {
    id: "discord",
    label: "Discord",
    validateTarget: async () => ({ ok: true, targetId: "tux" }),
    sendText: async () => ({ ok: true, sent: 1, failed: 0, messageIds: [1] }),
    react: async () => ({ ok: true, sent: 1, failed: 0, messageIds: [1] }),
    sendChoices: async () => ({ ok: true, messageId: 1, expiresAt: 5 }),
    sendMedia: async () => ({ ok: true, messageId: 1, mediaType: "photo", bytes: 1 }),
  } as never;
  const registry = createChannelChatRegistry([adapter, custom]);
  assert.equal(registry.get("discord"), custom);
  assert.equal(registry.get("telegram"), adapter);
  assert.equal(registry.list().length, 2);
});
