import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  channelConfigFile,
  createChannelManager,
  createChannelOwner,
  createTelegramChannelLifecycle,
} from "@xzy-ai/channels";
import { registerTelegramLifecycle, clearTelegramLifecycleRegistry } from "../src/registrations/telegram-lifecycle.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-telegram-lifecycle-"));
}

function writeValidConfig(cwd: string, token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWX"): void {
  const file = channelConfigFile(cwd);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ token, approvedUserIds: [] }), "utf8");
}

function registrations(): { pi: ExtensionAPI; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    pi: {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI,
  };
}

function context(cwd: string, sessionId: string): ExtensionContext {
  return {
    mode: "tui",
    hasUI: true,
    cwd,
    ui: { notify: () => {} },
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as ExtensionContext;
}

test("a valid configuration starts one connection on session start and stops it on shutdown", async () => {
  const cwd = projectRoot();
  writeValidConfig(cwd);
  let started = 0;
  let stopped = 0;
  const { pi, handlers } = registrations();
  registerTelegramLifecycle(pi, {
    createManager: () => ({
      state: () => ({ status: { kind: "idle" }, owned: false }),
      async start() {
        started += 1;
        return { ok: true, value: { status: { kind: "ready" }, owned: true } };
      },
      async stop() {
        stopped += 1;
      },
      replace: async () => ({ ok: true, value: { status: { kind: "ready" }, owned: true } }),
      owner: null as never,
      projectRoot: cwd,
    }),
  });
  await handlers.get("session_start")!({ reason: "startup" }, context(cwd, "root"));
  await handlers.get("session_shutdown")!({ reason: "quit" }, context(cwd, "root"));
  assert.equal(started, 1, "one connection starts on session start");
  assert.equal(stopped, 1, "the connection stops on shutdown");
  clearTelegramLifecycleRegistry();
});

test("no config on session start is a silent no-op", async () => {
  const cwd = projectRoot();
  let started = 0;
  const { pi, handlers } = registrations();
  registerTelegramLifecycle(pi, {
    createManager: () => ({
      state: () => ({ status: { kind: "idle" }, owned: false }),
      async start() {
        started += 1;
        return { ok: true, value: { status: { kind: "idle" }, owned: false } };
      },
      async stop() {},
      replace: async () => ({ ok: true, value: { status: { kind: "idle" }, owned: false } }),
      owner: null as never,
      projectRoot: cwd,
    }),
  });
  await handlers.get("session_start")!({ reason: "startup" }, context(cwd, "root"));
  assert.equal(started, 0, "no connection is started without a config");
  clearTelegramLifecycleRegistry();
});

test("reload/new/resume/fork sequences stop the old connection before any new start", async () => {
  const cwd = projectRoot();
  writeValidConfig(cwd);
  const events: string[] = [];
  const { pi, handlers } = registrations();
  registerTelegramLifecycle(pi, {
    createManager: () => ({
      state: () => ({ status: { kind: "idle" }, owned: false }),
      async start() {
        events.push("start");
        return { ok: true, value: { status: { kind: "ready" }, owned: true } };
      },
      async stop() {
        events.push("stop");
      },
      replace: async () => ({ ok: true, value: { status: { kind: "ready" }, owned: true } }),
      owner: null as never,
      projectRoot: cwd,
    }),
  });
  const start = handlers.get("session_start")!;
  const shutdown = handlers.get("session_shutdown")!;
  const ctx = () => context(cwd, "root-a");

  // startup
  await start({ reason: "startup" }, ctx());
  // reload: shutdown then start
  await shutdown({ reason: "reload" }, ctx());
  await start({ reason: "reload" }, ctx());
  // fork: shutdown then start
  await shutdown({ reason: "fork" }, ctx());
  await start({ reason: "fork" }, ctx());
  // resume: shutdown then start
  await shutdown({ reason: "resume" }, ctx());
  await start({ reason: "resume" }, ctx());
  // new: shutdown then start
  await shutdown({ reason: "new" }, ctx());
  await start({ reason: "new" }, ctx());

  assert.deepEqual(events, [
    "start",
    "stop", "start",
    "stop", "start",
    "stop", "start",
    "stop", "start",
  ], "each replacement stops before the next start; no duplicate starts or leaks");
  assert.equal(events.filter((e) => e === "start").length, 5, "exactly one start per session");
  assert.equal(events.filter((e) => e === "stop").length, 4, "one stop per replacement");
  clearTelegramLifecycleRegistry();
});

test("a second PI process in the same project fails closed and does not start Telegram", async () => {
  const cwd = projectRoot();
  writeValidConfig(cwd);

  // First process owns the connection through a real crash-safe owner record.
  const firstOwner = createChannelOwner(cwd, { pid: 424242 });
  const acquired = firstOwner.acquire();
  assert.equal(acquired.ok, true, "first process owns the connection");

  // Second process builds a manager against the same owner record and fails closed.
  const secondManager = createChannelManager({
    projectRoot: cwd,
    createPoller: () => {
      throw new Error("Telegram must never start for the second process");
    },
  });
  const lifecycle = createTelegramChannelLifecycle({ projectRoot: cwd, manager: secondManager });
  const result = await lifecycle.start();
  assert.equal(result.ok, false, "second process fails closed");
  if (!result.ok) {
    assert.match(result.message, /owned by process/);
  }
  assert.equal(secondManager.state().owned, false, "second process never owns the connection");

  firstOwner.release();
});