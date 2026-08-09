import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createChannelLogger,
  createTelegramTransport,
  telegramTokenFingerprint,
  channelLogFile,
  type BotLike,
  type RunnerHandleLike,
} from "../src/index.ts";

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-channels-transport-"));
}

const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWX";

interface FakeBotMeta {
  initError?: Error;
  catchHandler?: (error: unknown) => unknown;
  stopCalled?: number;
}

function fakeBot(meta: FakeBotMeta = {}): { bot: BotLike; handle: RunnerHandleLike; meta: FakeBotMeta } {
  let running = true;
  const handle: RunnerHandleLike = {
    async stop() {
      running = false;
    },
    isRunning() {
      return running;
    },
    task() {
      return undefined;
    },
  };
  const bot: BotLike = {
    api: { getMe: async () => ({ id: 1 }) },
    async init() {
      if (meta.initError) throw meta.initError;
    },
    catch(handler) {
      meta.catchHandler = handler;
    },
    async stop() {
      meta.stopCalled = (meta.stopCalled ?? 0) + 1;
    },
  };
  return { bot, handle, meta };
}

function configuredBot(meta: FakeBotMeta = {}): { bot: BotLike; handle: RunnerHandleLike; meta: FakeBotMeta } {
  return fakeBot(meta);
}

function transportDeps() {
  const root = projectRoot();
  const loggerResult = createChannelLogger({ projectRoot: root, sessionId: "transport-session" });
  assert.equal(loggerResult.ok, true);
  const logger = loggerResult.ok ? loggerResult.value : (null as never);
  return { root, logger };
}

/** Runner factory that records the bot it was given and returns the fake handle. */
function makeRunBot(handle: RunnerHandleLike) {
  return (_bot: BotLike) => handle;
}

test("a valid configured bot reaches ready status without a runner blocking readiness", async () => {
  const { root, logger } = transportDeps();
  const created = configuredBot();
  const transport = createTelegramTransport({
    logger,
    createBot: () => created.bot,
    runBot: makeRunBot(created.handle),
  });
  const result = await transport.start({ token: TOKEN, approvedUserIds: [] });
  assert.deepEqual(result, { ok: true, value: undefined });
  await transport.stop();

  const raw = readFileSync(channelLogFile(root, "transport-session"), "utf8");
  assert.equal(raw.includes("telegram_connected"), true);
  assert.equal(raw.includes(TOKEN), false);
});

test("rejects invalid credentials via the getMe probe and stays stopped", async () => {
  const { logger } = transportDeps();
  const { bot, handle } = fakeBot({ initError: Object.assign(new Error("Unauthorized"), { code: 401 }) });
  const transport = createTelegramTransport({ logger, createBot: () => bot, runBot: makeRunBot(handle) });
  const result = await transport.start({ token: TOKEN, approvedUserIds: [] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /rejected/);
  await transport.stop();
});

test("routing errors are caught and logged locally rather than becoming unhandled rejections", async () => {
  const { root, logger } = transportDeps();
  const created = fakeBot();
  const transport = createTelegramTransport({ logger, createBot: () => created.bot, runBot: makeRunBot(created.handle) });
  await transport.start({ token: TOKEN, approvedUserIds: [] });
  created.meta.catchHandler?.(new Error("middleware boom"));
  await transport.stop();

  const raw = readFileSync(channelLogFile(root, "transport-session"), "utf8");
  assert.equal(raw.includes("middleware boom"), true);
  assert.equal(raw.includes("telegram_middleware_error"), true);
});

test("stop is idempotent and releases the token fingerprint", async () => {
  const { logger } = transportDeps();
  const created = configuredBot();
  const transport = createTelegramTransport({ logger, createBot: () => created.bot, runBot: makeRunBot(created.handle) });
  await transport.start({ token: TOKEN, approvedUserIds: [] });
  await transport.stop();
  await transport.stop();
  assert.equal(created.meta.stopCalled, 1);

  // A second transport may start after the first fully stops.
  const secondCreated = configuredBot();
  const second = createTelegramTransport({ logger, createBot: () => secondCreated.bot, runBot: makeRunBot(secondCreated.handle) });
  const result = await second.start({ token: TOKEN, approvedUserIds: [] });
  assert.equal(result.ok, true);
  await second.stop();
});

test("a second transport never starts a competing poller for the same token", async () => {
  const { logger } = transportDeps();
  const firstCreated = configuredBot();
  const secondCreated = configuredBot();
  const first = createTelegramTransport({ logger, createBot: () => firstCreated.bot, runBot: makeRunBot(firstCreated.handle) });
  const second = createTelegramTransport({ logger, createBot: () => secondCreated.bot, runBot: makeRunBot(secondCreated.handle) });
  assert.equal((await first.start({ token: TOKEN, approvedUserIds: [] })).ok, true);
  const result = await second.start({ token: TOKEN, approvedUserIds: [] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /already active/);
  await first.stop();
  // After the first stops, the second may proceed.
  assert.equal((await second.start({ token: TOKEN, approvedUserIds: [] })).ok, true);
  await second.stop();
});

test("telegramTokenFingerprint is deterministic and never contains the raw token", () => {
  const a = telegramTokenFingerprint(TOKEN);
  const b = telegramTokenFingerprint(TOKEN);
  assert.equal(a, b);
  assert.equal(a.includes(TOKEN), false);
  assert.equal(a.startsWith("telegram:"), true);
});