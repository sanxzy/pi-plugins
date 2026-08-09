import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTelegramInbound,
  decodeAcceptedText,
  formatTelegramSignature,
  type TelegramInboundListener,
} from "../src/inbound.ts";

function privateText(updateId: number, fromId: string, text: string, type = "private", extra: Record<string, unknown> = {}): unknown {
  return {
    update_id: updateId,
    message: {
      chat: { id: 123, type },
      from: { id: Number(fromId) },
      text,
      ...extra,
    },
  };
}

test("decodeAcceptedText accepts a private text message from an approved identity", () => {
  const decoded = decodeAcceptedText(privateText(1, "111", "hello"));
  assert.deepEqual(decoded, { updateId: 1, chatId: "123", fromId: "111", text: "hello" });
});

test("decodeAcceptedText rejects non-private, edited, non-text, and identity-missing updates", () => {
  assert.equal(decodeAcceptedText(privateText(1, "111", "hi", "group")), undefined, "group chat rejected");
  assert.equal(decodeAcceptedText(privateText(1, "111", "hi", "private", { edit_date: 123 })), undefined, "edited rejected");
  const noText = privateText(1, "111", "hi");
  (noText as { message: { text?: string } }).message.text = undefined;
  assert.equal(decodeAcceptedText(noText), undefined, "non-text rejected");
  const empty = privateText(1, "111", "   ");
  assert.equal(decodeAcceptedText(empty), undefined, "blank text rejected");
  const noFrom = privateText(1, "111", "hi");
  (noFrom as { message: { from?: unknown } }).message.from = undefined;
  assert.equal(decodeAcceptedText(noFrom), undefined, "missing sender rejected");
  assert.equal(decodeAcceptedText(undefined), undefined, "empty context rejected");
});

test("formatTelegramSignature is the exact origin marker", () => {
  assert.equal(formatTelegramSignature("123"), "\n\n---\n[from:telegram:123]\n---");
});

function makeListener(approved: string[], onAccepted: (id: number, chat: string, text: string) => Promise<void> = async () => {}): {
  listener: TelegramInboundListener;
  accepted: { updateId: number; chatId: string; text: string }[];
  errors: unknown[];
} {
  const accepted: { updateId: number; chatId: string; text: string }[] = [];
  const errors: unknown[] = [];
  const listener = createTelegramInbound({
    approvedUserIds: approved,
    onAccepted: async (updateId, chatId, text) => {
      accepted.push({ updateId, chatId, text });
      await onAccepted(updateId, chatId, text);
    },
    onError: (error) => errors.push(error),
  });
  return { listener, accepted, errors };
}

test("inbound only delivers authorized private text and dedupes update ids", async () => {
  const { listener, accepted } = makeListener(["111"]);
  await listener.handle(privateText(1, "111", "first"));
  await listener.handle(privateText(2, "222", "unauthorized"));
  await listener.handle(privateText(1, "111", "duplicate"));
  await listener.handle(privateText(3, "111", "second"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(accepted.length, 1, "only the first authorized item drains while idle");
  listener.releaseNext();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    accepted.map((a) => a.text),
    ["first", "second"],
    "deduplicated, authorized text is then released",
  );
  listener.stop();
});

test("inbound queues FIFO and delivers one at a time while busy", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { listener, accepted } = makeListener(["111"], async () => { await gate; });

  listener.setBusy(false);
  await listener.handle(privateText(1, "111", "one"));
  await listener.handle(privateText(2, "111", "two"));
  await listener.handle(privateText(3, "111", "three"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  // While the first delivery is in flight, only one item is draining.
  assert.equal(accepted.length, 1, "one follow-up drains while the first is in flight");

  release!();
  await gate;
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The next item is not released until the root turn settles.
  assert.deepEqual(accepted.map((a) => a.text), ["one"], "queued items wait for settlement");
  listener.releaseNext();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(accepted.map((a) => a.text), ["one", "two"], "one follow-up drains after settlement");
  listener.releaseNext();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(accepted.map((a) => a.text), ["one", "two", "three"], "the next queued item drains on the next release");
  listener.stop();
});

test("inbound reports delivery failures through onError", async () => {
  const { listener, errors } = makeListener(["111"], async () => { throw new Error("boom"); });
  await listener.handle(privateText(1, "111", "fail"));
  // Wait for the async drain to settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(errors.length, 1, "delivery failure routes to onError");
  listener.stop();
});

test("a persisted last update id suppresses replay after a restart", async () => {
  const { listener, accepted } = makeListener(["111"]);
  // Simulate loading the persisted marker from a previous process that already
  // delivered update 5.
  listener.setLastUpdateId(5);
  await listener.handle(privateText(5, "111", "already delivered"));
  await listener.handle(privateText(4, "111", "older"));
  await listener.handle(privateText(6, "111", "new"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    accepted.map((a) => a.text),
    ["new"],
    "only updates newer than the persisted identity are delivered",
  );
  listener.stop();
});