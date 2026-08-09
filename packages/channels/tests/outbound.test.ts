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

test("outbound gate uses the latest Telegram marker and chat", async () => {
  const markers = new Map<string, { lastConnection?: "telegram" | "tui"; chatRoomId?: string }>();
  const configs = new Map<string, { token: string }>();
  markers.set("telegram", { lastConnection: "telegram", chatRoomId: "777" });
  markers.set("tui", { lastConnection: "tui", chatRoomId: "777" });
  configs.set("telegram", { token: "123456789:ABCDEFGHIJKLMNOPQRSTUVWX" });
  const sent: Array<{ chat: string | number; text: string }> = [];
  const outbound = createTelegramOutbound({
    readMarker: (root) => {
      const marker = markers.get(root);
      return marker ? { ok: true, value: marker } : { ok: false, code: "missing", message: "missing" };
    },
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

  assert.equal(outbound.canSend("telegram"), true);
  assert.equal(outbound.targetChat("telegram"), "777");
  assert.equal(outbound.canSend("tui"), false);
  assert.equal(outbound.targetChat("tui"), undefined);
  const result = await outbound.send("telegram", "hello");
  assert.deepEqual(result, { ok: true, sent: 1, failed: 0 });
  assert.deepEqual(sent, [{ chat: "777", text: "hello" }]);
});

test("outbound fails closed for an unset marker", async () => {
  const outbound = createTelegramOutbound({
    readMarker: () => ({ ok: false, code: "missing", message: "missing" }),
  });
  assert.equal(outbound.canSend("project"), false);
  assert.equal(outbound.targetChat("project"), undefined);
  assert.deepEqual(await outbound.send("project", "hello"), {
    ok: false,
    sent: 0,
    failed: 1,
    error: "connection_not_telegram",
  });
});