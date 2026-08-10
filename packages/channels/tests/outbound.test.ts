import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTelegramOutbound,
  sendTextChunks,
  splitTextChunks,
  MAX_TEXT_LENGTH,
} from "../src/outbound.ts";

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
  });
  assert.deepEqual(sent, ["x".repeat(MAX_TEXT_LENGTH), "x".repeat(MAX_TEXT_LENGTH)]);
  assert.deepEqual(result, { ok: false, sent: 1, failed: 1, error: "second chunk failed" });
});

test("outbound sends to an explicit chat id and reports chunk count", async () => {
  const configs = new Map<string, { token: string }>();
  configs.set("telegram", { token: "123456789:ABCDEFGHIJKLMNOPQRSTUVWX" });
  const sent: Array<{ chat: string | number; text: string }> = [];
  const outbound = createTelegramOutbound({
    readConfig: (root) => {
      const config = configs.get(root);
      return config ? { ok: true, value: { ...config, approvedUserIds: [] } } : { ok: false, code: "missing", message: "missing" };
    },
    createSendApi: () => ({
      async sendMessage(chat, text) {
        sent.push({ chat, text });
      },
    }),
  });

  const result = await outbound.send("telegram", "777", "hello");
  assert.deepEqual(result, { ok: true, sent: 1, failed: 0 });
  assert.deepEqual(sent, [{ chat: "777", text: "hello" }]);
});

test("outbound fails closed when the channel is not configured", async () => {
  const outbound = createTelegramOutbound({
    readConfig: () => ({ ok: false, code: "missing", message: "missing" }),
  });
  assert.deepEqual(await outbound.send("project", "777", "hello"), {
    ok: false,
    sent: 0,
    failed: 1,
    error: "Telegram channel not configured",
  });
});