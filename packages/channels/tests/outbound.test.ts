import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Bot, GrammyError } from "grammy";
import { runtimeDir } from "@xzy-ai/runtime";
import {
  canSendTelegram,
  createBot,
  saveChannelConfig,
  saveConnectionMarker,
  sendTelegramMessage,
  sendWithBot,
  type ChannelConfig,
} from "../src/index.ts";
import { sendTextChunks, splitTextChunks } from "../src/outbound/send.ts";

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-channels-out-"));
}

function config(): ChannelConfig {
  return {
    botToken: "123456:FAKE-TOKEN",
    defaultChatId: "42",
    allowedChatIds: ["42"],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("splitTextChunks keeps short text as a single chunk", () => {
  assert.deepEqual(splitTextChunks("hello"), ["hello"]);
  assert.deepEqual(splitTextChunks("x".repeat(4096)), ["x".repeat(4096)]);
});

test("splitTextChunks splits long text at paragraph boundaries within the limit", () => {
  const paragraphs = Array.from({ length: 5 }, (_, i) => `Paragraph ${i}: ${"word ".repeat(200)}`).join("\n\n");
  assert.ok(paragraphs.length > 4096);
  const chunks = splitTextChunks(paragraphs);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 4096);
  }
  assert.equal(chunks.join(""), paragraphs);
});

test("splitTextChunks hard-splits text without line breaks", () => {
  const text = "x".repeat(10000);
  const chunks = splitTextChunks(text);
  assert.ok(chunks.length >= 3);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 4096);
  }
  assert.equal(chunks.join(""), text);
});

test("sendTextChunks sends consecutive messages to the same chat, each within the limit", async () => {
  const calls: Array<{ chatId: string; text: string }> = [];
  const result = await sendTextChunks("42", "x".repeat(9000), {
    sendText: async (chatId, text) => {
      calls.push({ chatId, text });
      return {};
    },
    sleep: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.sent, calls.length);
  assert.equal(result.failed, 0);
  assert.ok(calls.length >= 3);
  for (const call of calls) {
    assert.equal(call.chatId, "42");
    assert.ok(call.text.length <= 4096);
  }
});

test("sendTextChunks retries transient failures up to three total attempts with short backoff", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  const result = await sendTextChunks("42", "hello", {
    sendText: async () => {
      attempts++;
      if (attempts < 3) {
        throw new GrammyError(
          "Call to 'sendMessage' failed!",
          { ok: false, error_code: 500, description: "Internal Server Error" },
          "sendMessage",
          {},
        );
      }
      return {};
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
});

test("sendTextChunks gives up after three failed attempts", async () => {
  let attempts = 0;
  const result = await sendTextChunks("42", "hello", {
    sendText: async () => {
      attempts++;
      throw new GrammyError(
        "Call to 'sendMessage' failed!",
        { ok: false, error_code: 500, description: "Internal Server Error" },
        "sendMessage",
        {},
      );
    },
    sleep: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(attempts, 3);
  assert.equal(result.failed, 1);
  assert.equal(typeof result.error, "string");
});

test("permanent errors (invalid token, chat not found, message too long) are never retried", async () => {
  const permanent: Array<{ code: number; description: string }> = [
    { code: 401, description: "Unauthorized" },
    { code: 400, description: "Bad Request: chat not found" },
    { code: 400, description: "Bad Request: message is too long" },
  ];
  for (const entry of permanent) {
    let attempts = 0;
    const result = await sendTextChunks("42", "hello", {
      sendText: async () => {
        attempts++;
        throw new GrammyError(
          "Call to 'sendMessage' failed!",
          { ok: false, error_code: entry.code, description: entry.description },
          "sendMessage",
          {},
        );
      },
      sleep: async () => {
        throw new Error("permanent errors must not sleep");
      },
    });
    assert.equal(result.ok, false, entry.description);
    assert.equal(attempts, 1, entry.description);
  }
});

test("canSendTelegram is true only when the fresh marker says telegram", () => {
  const root = projectRoot();
  assert.equal(canSendTelegram(root), false, "missing marker");
  saveConnectionMarker(root, { lastConnection: "tui", updatedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(canSendTelegram(root), false, "tui marker");
  saveConnectionMarker(root, { lastConnection: "telegram", updatedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(canSendTelegram(root), true, "telegram marker");
  mkdirSync(runtimeDir(root), { recursive: true });
  writeFileSync(join(runtimeDir(root), "user_last_connection.json"), "broken", "utf-8");
  assert.equal(canSendTelegram(root), false, "malformed marker");
});

test("sendTelegramMessage targets only the configured default chat", async () => {
  const root = projectRoot();
  saveChannelConfig(root, config());
  const calls: Array<{ chatId: string; text: string }> = [];
  const result = await sendTelegramMessage(root, "hello", {
    createBot: () => ({
      api: {
        sendMessage: async (chatId: number | string, text: string) => {
          calls.push({ chatId: String(chatId), text });
          return {};
        },
      },
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.sent, 1);
  assert.deepEqual(calls, [{ chatId: "42", text: "hello" }]);
});

test("sendTelegramMessage fails clearly when unconfigured without creating a bot", async () => {
  const root = projectRoot();
  const result = await sendTelegramMessage(root, "hello", {
    createBot: () => {
      throw new Error("must not create a bot when unconfigured");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.sent, 0);
  assert.match(result.error ?? "", /not configured/i);
});

test("bot outbound calls are verified through the grammY transformer seam without network", async () => {
  const bot = new Bot("123456:FAKE-TOKEN");
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return Promise.resolve({ ok: true, result: { message_id: 1 } }) as never;
  });
  const result = await sendWithBot(bot, "-1001234567890", "hello");
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ method: "sendMessage", payload: { chat_id: "-1001234567890", text: "hello" } }]);
});

test("createBot installs a catch handler that warns without throwing", async () => {
  const warnings: string[] = [];
  const bot = createBot("123456:FAKE-TOKEN", { warn: (message) => warnings.push(message) });
  await bot.errorHandler({ error: new Error("middleware boom"), ctx: undefined } as never);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /middleware boom/);
});
