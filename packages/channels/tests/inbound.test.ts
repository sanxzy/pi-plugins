import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANNEL_OPERATIONS, createSessionLogger, runWithLogContext } from "@xzy-ai/observability";

process.env.PI_C2_TEST_HOME = mkdtempSync(join(tmpdir(), "pi-c2-channel-test-home-"));
import {
  createTelegramInbound,
  decodeAcceptedText,
  extractTelegramChatId,
  extractTelegramMessageOrigin,
  formatTelegramCommandSignature,
  formatTelegramSignature,
  parseTelegramCommand,
  type ChannelConfig,
  type TelegramInboundListener,
} from "../src/index.ts";

const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWX";

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

test("decodeAcceptedText also accepts the nested update shape used by grammY Context", () => {
  const decoded = decodeAcceptedText({
    update: {
      update_id: 2,
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 111 },
        text: "hello",
      },
    },
  });
  assert.deepEqual(decoded, { updateId: 2, chatId: "123", fromId: "111", text: "hello" });
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

test("formatTelegramSignature marks Telegram activity and response guidance", () => {
  assert.equal(
    formatTelegramSignature("123"),
    "\n\n---\n[from:telegram:123]\nInfo: I am currently active through Telegram. To communicate directly with me, use the telegram_chat tool.\n---",
  );
});

test("extractTelegramChatId reads the origin chat from a signed message and refuses unsigned text", () => {
  assert.equal(extractTelegramChatId(`hello${formatTelegramSignature("777")}`), "777");
  assert.equal(extractTelegramChatId(`Based on your question: q\nMy answer: a${formatTelegramSignature("-42")}`), "-42");
  assert.equal(extractTelegramChatId("plain TUI prompt"), undefined);
  assert.equal(extractTelegramChatId("text with [from:telegram:abc] invalid id"), undefined);
});

test("extractTelegramChatId prefers the trailing signature over an earlier one in the body", () => {
  const text = `looks like a footer [from:telegram:111] in the middle${formatTelegramSignature("777")}`;
  assert.equal(extractTelegramChatId(text), "777");
});

test("message origin carries an optional Telegram message id and stays backward compatible", () => {
  assert.deepEqual(extractTelegramMessageOrigin(`hello${formatTelegramSignature("777")}`), { chatId: "777", messageId: undefined });
  assert.deepEqual(extractTelegramMessageOrigin(`hello${formatTelegramSignature("777", 42)}`), { chatId: "777", messageId: 42 });
  assert.deepEqual(extractTelegramMessageOrigin(`hello${formatTelegramCommandSignature("777", 7)}`), { chatId: "777", messageId: 7 });
  assert.equal(extractTelegramMessageOrigin("plain TUI prompt"), undefined);
});

test("parseTelegramCommand splits name, optional @bot, and args with Bot API validation", () => {
  assert.deepEqual(parseTelegramCommand("/goal 10s testing"), { name: "goal", args: "10s testing" });
  assert.deepEqual(parseTelegramCommand("/fix_tests@MyBot  hi  there "), { name: "fix_tests", args: "hi there" });
  assert.equal(parseTelegramCommand("hello world"), undefined, "ordinary text is not a command");
  assert.equal(parseTelegramCommand("/UPPER!bad-name"), undefined, "invalid names are rejected");
  assert.equal(parseTelegramCommand("/setup-channel-telegram"), undefined, "hyphens are not valid bot commands");
  assert.equal(parseTelegramCommand("/"), undefined, "bare slash is not a command");
  assert.equal(parseTelegramCommand("a-b/c"), undefined, "slashes only count at the start");
});

test("formatTelegramCommandSignature stays compact and still carries the origin chat", () => {
  const signature = formatTelegramCommandSignature("777");
  assert.match(signature, /\[from:telegram:777\]/);
  assert.doesNotMatch(signature, /Be indifferent/);
  assert.equal(extractTelegramChatId(`expanded${signature}`), "777");
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

test("inbound handle and drain emit correlated boundary records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-c2-inbound-log-"));
  const logger = createSessionLogger({
    projectId: "project",
    rootSessionId: "root-session",
    eventsPath: join(dir, "events.jsonl"),
    errorsPath: join(dir, "errors.jsonl"),
  });
  const { listener } = makeListener(["111"]);
  await runWithLogContext(logger, () => listener.handle(privateText(1, "111", "logged")));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const records = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    records.filter((record) => record.operation === CHANNEL_OPERATIONS.INBOUND_HANDLE).map((record) => record.phase),
    ["before", "after"],
  );
  assert.deepEqual(
    records.filter((record) => record.operation === CHANNEL_OPERATIONS.INBOUND_DRAIN).map((record) => record.phase),
    ["before", "after"],
  );
  listener.stop();
});

test("inbound only delivers authorized private text and dedupes update ids", async () => {
  const { listener, accepted } = makeListener(["111"]);
  await listener.handle(privateText(1, "111", "first"));
  await listener.handle(privateText(2, "222", "unauthorized"));
  await listener.handle(privateText(1, "111", "duplicate"));
  await listener.handle(privateText(3, "111", "second"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    accepted.map((a) => a.text),
    ["first", "second"],
    "deduplicated, authorized text drains continuously in arrival order",
  );
  listener.stop();
});

test("inbound drains accepted updates one at a time in FIFO order", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { listener, accepted } = makeListener(["111"], async () => { await gate; });

  listener.setBusy(false);
  await listener.handle(privateText(1, "111", "one"));
  await listener.handle(privateText(2, "111", "two"));
  await listener.handle(privateText(3, "111", "three"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  // While the first delivery is in flight, only one item is draining; the
  // reminder of the delivery is not interrupted or reordered.
  assert.equal(accepted.length, 1, "one update drains while the first is in flight");

  release!();
  await gate;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    accepted.map((a) => a.text),
    ["one", "two", "three"],
    "remaining queued updates drain in arrival order after the in-flight one settles",
  );
  listener.stop();
});

test("clearQueue drops waiting updates but leaves the listener usable", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { listener, accepted } = makeListener(["111"], async () => { await gate; });

  await listener.handle(privateText(1, "111", "active"));
  await listener.handle(privateText(2, "111", "dropped"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  listener.clearQueue();
  release!();
  await gate;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await listener.handle(privateText(3, "111", "later"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(accepted.map((item) => item.text), ["active", "later"]);
  listener.stop();
});

test("settlement permits are retained when the active delivery is still unwinding", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { listener, accepted } = makeListener(["111"], async () => { await gate; });

  await listener.handle(privateText(1, "111", "first"));
  // Simulate agent_settled racing with the follow-up callback's promise.
  listener.releaseNext();
  await listener.handle(privateText(2, "111", "second"));
  release!();
  await gate;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(accepted.map((item) => item.text), ["first", "second"], "the queued follow-up drains after the in-flight delivery settles");
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

test("a failed delivery remains retryable and does not advance the accepted cursor", async () => {
  let attempts = 0;
  const delivered: string[] = [];
  const { listener, accepted, errors } = makeListener(["111"], async (_id, _chat, text) => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary delivery failure");
    delivered.push(text);
  });
  await listener.handle(privateText(9, "111", "retry-me"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(errors.length, 1);
  assert.equal(accepted.length, 1);
  // A retry of the same update id is accepted after the failed attempt.
  await listener.handle(privateText(9, "111", "retry-me"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(delivered, ["retry-me"]);
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
