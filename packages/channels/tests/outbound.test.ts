import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTelegramOutbound,
  sendTextChunks,
  splitTextChunks,
  MAX_TEXT_LENGTH,
} from "../src/outbound.ts";

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
