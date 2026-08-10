import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTelegramOutbound,
  sendTextChunks,
  splitTextChunks,
  MAX_TEXT_LENGTH,
  validateStandardReaction,
  reactToMessage,
  MEDIA_DOCUMENT_MAX_BYTES,
} from "../src/index.ts";

const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWX";

test("splitTextChunks preserves ordered content and stays within 4000 characters", () => {
  const text = "a".repeat(MAX_TEXT_LENGTH * 2 + 17);
  const chunks = splitTextChunks(text);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => chunk.length <= MAX_TEXT_LENGTH));
  assert.equal(chunks.length, 3);
});

test("splitTextChunks prefers boundaries without dropping separators", () => {
  const text = `${"a".repeat(MAX_TEXT_LENGTH - 2)}\n${"b".repeat(MAX_TEXT_LENGTH)}`;
  const chunks = splitTextChunks(text);
  assert.equal(chunks.join(""), text);
  assert.equal(chunks[0]?.length, MAX_TEXT_LENGTH - 2, "newline boundary is preferred");
});

test("sendTextChunks sends ordered chunks and reports partial failure", async () => {
  const sent: string[] = [];
  const text = "x".repeat(MAX_TEXT_LENGTH * 2 + 3);
  const result = await sendTextChunks("123", text, async (_chat, chunk) => {
    sent.push(chunk);
    if (sent.length === 2) throw new Error("second chunk failed");
    return sent.length;
  });
  assert.deepEqual(sent, ["x".repeat(MAX_TEXT_LENGTH), "x".repeat(MAX_TEXT_LENGTH)]);
  assert.deepEqual(result, {
    ok: false,
    sent: 1,
    failed: 1,
    error: "second chunk failed",
    category: "partial_delivery",
  });
});

test("sendChoices sends an inline keyboard and returns the prompt message id", async () => {
  const sent: unknown[] = [];
  const outbound = createTelegramOutbound({
    readConfig: () => ({ ok: true, value: { token, approvedUserIds: ["777"] } }),
    createSendApi: () => ({
      async sendMessage(chat, text, other) {
        sent.push([chat, text, other]);
        return { message_id: 200 };
      },
    }),
  });
  const result = await outbound.sendChoices("project", "777", "Proceed?", [
    { label: "Yes", callbackData: "tc_opaque_0" },
    { label: "No", callbackData: "tc_opaque_1" },
  ]);
  assert.deepEqual(result, { ok: true, messageId: 200, expiresAt: result.ok ? result.expiresAt : 0 });
  assert.deepEqual(sent[0], ["777", "Proceed?", {
    reply_markup: { inline_keyboard: [[
      { text: "Yes", callback_data: "tc_opaque_0" },
      { text: "No", callback_data: "tc_opaque_1" },
    ]] },
  }]);
});

test("outbound sends to an approved explicit chat and captures message ids", async () => {
  const sent: Array<{ chat: string | number; text: string }> = [];
  const outbound = createTelegramOutbound({
    readConfig: () => ({ ok: true, value: { token, approvedUserIds: ["777"] } }),
    createSendApi: () => ({
      async sendMessage(chat, text) {
        sent.push({ chat, text });
        return { message_id: 101 };
      },
    }),
  });

  const result = await outbound.send("project", "777", "hello");
  assert.deepEqual(result, { ok: true, sent: 1, failed: 0, messageIds: [101] });
  assert.deepEqual(sent, [{ chat: "777", text: "hello" }]);
});

test("outbound rejects an unapproved explicit chat before the API call", async () => {
  let called = false;
  const outbound = createTelegramOutbound({
    readConfig: () => ({ ok: true, value: { token, approvedUserIds: ["888"] } }),
    createSendApi: () => ({
      async sendMessage() {
        called = true;
        return { message_id: 1 };
      },
    }),
  });

  const result = await outbound.send("project", "777", "hello");
  assert.equal(called, false);
  assert.deepEqual(result, {
    ok: false,
    sent: 0,
    failed: 1,
    error: "Telegram target is not an approved private chat",
    category: "target_not_approved",
  });
});

test("sendMedia uploads a photo with caption and upload status", async () => {
  const actions: unknown[] = [];
  const uploads: unknown[] = [];
  const outbound = createTelegramOutbound({
    readConfig: () => ({ ok: true, value: { token, approvedUserIds: ["777"] } }),
    createSendApi: () => ({
      async sendMessage() { return { message_id: 1 }; },
      async sendChatAction(chat: string | number, action: string) { actions.push([chat, action]); },
      async sendPhoto(chat: string | number, photo: unknown, other: unknown) { uploads.push([chat, photo, other]); return { message_id: 55, photo: [] }; },
    }),
  });
  const result = await outbound.sendMedia("project", "777", "photo", {
    kind: "bytes", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xdb]), contentType: "image/jpeg", filename: "pic.jpg",
  }, { caption: "Look" });
  assert.deepEqual(result, { ok: true, messageId: 55, mediaType: "photo", bytes: 4, filename: "pic.jpg" });
  assert.deepEqual(actions, [["777", "upload_photo"]]);
  assert.equal(uploads.length, 1);
  const photoUpload = uploads[0] as unknown[];
  assert.equal(photoUpload[0], "777");
  assert.deepEqual(photoUpload[2], { caption: "Look" });
});

test("sendMedia uploads a document with filename and reports safe metadata", async () => {
  const uploads: unknown[] = [];
  const outbound = createTelegramOutbound({
    readConfig: () => ({ ok: true, value: { token, approvedUserIds: ["777"] } }),
    createSendApi: () => ({
      async sendDocument(chat: string | number, document: unknown, other: unknown) { uploads.push([chat, document, other]); return { message_id: 56, document: {} }; },
    }),
  });
  const result = await outbound.sendMedia("project", "777", "document", {
    kind: "bytes", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), contentType: "application/pdf", filename: "../../report.pdf",
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result, { ok: true, messageId: 56, mediaType: "document", bytes: 4, filename: "report.pdf" });
  assert.equal(uploads.length, 1);
});

test("sendMedia rejects oversized and mismatched media before upload", async () => {
  let calls = 0;
  const outbound = createTelegramOutbound({
    readConfig: () => ({ ok: true, value: { token, approvedUserIds: ["777"] } }),
    createSendApi: () => ({
      async sendPhoto(_chat: string | number, _photo: unknown, _other?: Record<string, unknown>) { calls += 1; return { message_id: 1 }; },
      async sendDocument(_chat: string | number, _document: unknown, _other?: Record<string, unknown>) { calls += 1; return { message_id: 2 }; },
    }),
  });
  const oversized = await outbound.sendMedia("project", "777", "document", {
    kind: "bytes", bytes: new Uint8Array(MEDIA_DOCUMENT_MAX_BYTES + 1), contentType: "application/pdf", filename: "big.pdf",
  });
  assert.equal(oversized.ok, false);
  const mismatch = await outbound.sendMedia("project", "777", "photo", {
    kind: "bytes", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), contentType: "application/pdf", filename: "wrong.pdf",
  });
  assert.equal(mismatch.ok, false);
  assert.equal(calls, 0);
});

test("sendMedia does not retry ambiguous upload failures", async () => {
  let calls = 0;
  const outbound = createTelegramOutbound({
    readConfig: () => ({ ok: true, value: { token, approvedUserIds: ["777"] } }),
    createSendApi: () => ({
      async sendDocument(_chat: string | number, _document: unknown, _other?: Record<string, unknown>) { calls += 1; throw Object.assign(new Error("socket timeout"), { code: "ETIMEDOUT" }); },
    }),
  });
  const result = await outbound.sendMedia("project", "777", "document", {
    kind: "bytes", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), contentType: "application/pdf", filename: "x.pdf",
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.category, "network_error");
});

test("outbound reacts to a specific approved Telegram message", async () => {
  const reactions: Array<{ chat: string | number; messageId: number; reaction: unknown }> = [];
  const outbound = createTelegramOutbound({
    readConfig: () => ({ ok: true, value: { token, approvedUserIds: ["777"] } }),
    createSendApi: () => ({
      async sendMessage() {},
      async setMessageReaction(chat, messageId, reaction) {
        reactions.push({ chat, messageId, reaction });
      },
    }),
  });

  const result = await outbound.react("project", "777", 42, [{ type: "emoji", emoji: "👍" }]);
  assert.deepEqual(result, { ok: true, sent: 1, failed: 0, messageIds: [42] });
  assert.deepEqual(reactions, [{ chat: "777", messageId: 42, reaction: [{ type: "emoji", emoji: "👍" }] }]);
});

test("validateStandardReaction accepts only allowlisted standard emoji", () => {
  assert.equal(validateStandardReaction("👍"), true);
  assert.equal(validateStandardReaction("❤"), true);
  assert.equal(validateStandardReaction("not-an-emoji"), false);
  assert.equal(validateStandardReaction(""), false);
});

test("outbound reports a stable not_configured category", async () => {
  const outbound = createTelegramOutbound({
    readConfig: () => ({ ok: false, code: "missing", message: "missing" }),
  });
  assert.deepEqual(await outbound.send("project", "777", "hello"), {
    ok: false,
    sent: 0,
    failed: 1,
    error: "Telegram channel not configured",
    category: "not_configured",
  });
});

test("rich text maps format, reply, link preview, notification, and typing options", async () => {
  const actions: unknown[] = [];
  const messages: unknown[] = [];
  const outbound = createTelegramOutbound({
    readConfig: () => ({ ok: true, value: { token, approvedUserIds: ["777"] } }),
    createSendApi: () => ({
      async sendChatAction(chat, action) {
        actions.push([chat, action]);
      },
      async sendMessage(chat, text, other) {
        messages.push([chat, text, other]);
        return { message_id: 101 };
      },
    }),
  });

  const result = await outbound.send("project", "777", "<b>hello</b>", {
    format: "html",
    messageId: 42,
    linkPreviewOptions: { is_disabled: true },
    disableNotification: true,
  });

  assert.deepEqual(result, { ok: true, sent: 1, failed: 0, messageIds: [101] });
  assert.deepEqual(actions, [["777", "typing"]]);
  assert.deepEqual(messages, [["777", "<b>hello</b>", {
    parse_mode: "HTML",
    reply_parameters: { message_id: 42 },
    link_preview_options: { is_disabled: true },
    disable_notification: true,
  }]]);
});

test("typing status failure does not block text delivery", async () => {
  let sent = false;
  const outbound = createTelegramOutbound({
    readConfig: () => ({ ok: true, value: { token, approvedUserIds: ["777"] } }),
    createSendApi: () => ({
      async sendChatAction() {
        throw new Error("status unavailable");
      },
      async sendMessage() {
        sent = true;
        return { message_id: 102 };
      },
    }),
  });

  const result = await outbound.send("project", "777", "hello");
  assert.equal(sent, true);
  assert.equal(result.ok, true);
});

test("formatted text over the chunk limit is rejected without an unsafe split", async () => {
  let calls = 0;
  const outbound = createTelegramOutbound({
    readConfig: () => ({ ok: true, value: { token, approvedUserIds: ["777"] } }),
    createSendApi: () => ({
      async sendMessage() {
        calls += 1;
        return { message_id: 103 };
      },
    }),
  });

  const result = await outbound.send("project", "777", `<b>${"x".repeat(4000)}</b>`, { format: "html" });
  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.category, "telegram_rejected");
});

test("Telegram API parse rejection is categorized as telegram_rejected without retry", async () => {
  let calls = 0;
  const outbound = createTelegramOutbound({
    readConfig: () => ({ ok: true, value: { token, approvedUserIds: ["777"] } }),
    createSendApi: () => ({
      async sendMessage() {
        calls += 1;
        throw { error_code: 400, description: "Bad Request: can't parse entities" };
      },
    }),
  });
  const result = await outbound.send("project", "777", "<b>bad", { format: "html" });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.category, "telegram_rejected");
});

test("a rejected media upload is categorized as telegram_rejected", async () => {
  let calls = 0;
  const outbound = createTelegramOutbound({
    readConfig: () => ({ ok: true, value: { token, approvedUserIds: ["777"] } }),
    createSendApi: () => ({
      async sendDocument() {
        calls += 1;
        throw { error_code: 400, description: "Bad Request: file is not a document" };
      },
    }),
  });
  const result = await outbound.sendMedia("project", "777", "document", {
    kind: "bytes", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), contentType: "application/pdf", filename: "x.pdf",
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.category, "telegram_rejected");
});

test("ambiguous network timeout is attempted once and categorized without blind retry", async () => {
  let calls = 0;
  const outbound = createTelegramOutbound({
    readConfig: () => ({ ok: true, value: { token, approvedUserIds: ["777"] } }),
    createSendApi: () => ({
      async sendMessage() {
        calls += 1;
        throw Object.assign(new Error("socket timeout"), { code: "ETIMEDOUT" });
      },
    }),
  });

  const result = await outbound.send("project", "777", "hello");
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.category, "network_error");
});

test("Telegram 429 retry_after is retried once and categorized when exhausted", async () => {
  let calls = 0;
  const outbound = createTelegramOutbound({
    sleep: async () => undefined,
    readConfig: () => ({ ok: true, value: { token, approvedUserIds: ["777"] } }),
    createSendApi: () => ({
      async sendMessage() {
        calls += 1;
        throw { error_code: 429, description: "Too Many Requests", parameters: { retry_after: 0 } };
      },
    }),
  });

  const result = await outbound.send("project", "777", "hello");
  assert.equal(calls, 2);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.category, "rate_limited");
});
