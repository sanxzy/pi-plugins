import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getChildPool } from "@xzy-ai/runtime";
import { registerTelegramInbound } from "../src/registrations/telegram-inbound.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-inbound-"));
}

function writeChannel(root: string): void {
  const dir = join(root, ".pi", "pi-code");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "channel.json"),
    JSON.stringify({
      botToken: "123456:SECRET-TOKEN",
      defaultChatId: "42",
      allowedChatIds: ["42"],
      updatedAt: new Date().toISOString(),
    }),
    "utf8",
  );
}

function registrations(): { pi: ExtensionAPI; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    pi: {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      getCommands: () => [],
      sendUserMessage: () => {},
    } as unknown as ExtensionAPI,
  };
}

function context(cwd: string, sessionId: string): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => join(cwd, "sessions", `${sessionId}.jsonl`),
    },
  } as unknown as ExtensionContext;
}

test("registerTelegramInbound registers session_start, agent_settled, turn_start, and session_shutdown handlers", () => {
  const root = projectRoot();
  try {
    const d = registrations();
    registerTelegramInbound(d.pi);
    assert.equal(d.handlers.has("session_start"), true);
    assert.equal(d.handlers.has("agent_settled"), true);
    assert.equal(d.handlers.has("turn_start"), true);
    assert.equal(d.handlers.has("session_shutdown"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session_start with no channel config starts no listener", async () => {
  const root = projectRoot();
  try {
    const d = registrations();
    registerTelegramInbound(d.pi);
    // No channel.json exists; the handler must return without throwing.
    await d.handlers.get("session_start")!({ reason: "startup" }, context(root, "root-session"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session_start only starts the lifecycle for the root session, never a child", async () => {
  const root = projectRoot();
  try {
    writeChannel(root);
    const started: Array<{ projectRoot: string; sessionId: string }> = [];
    const d = registrations();
    registerTelegramInbound(d.pi, {
      createLifecycle: (options) => {
        started.push({ projectRoot: options.projectRoot, sessionId: options.sessionId });
        return {
          start: async () => {},
          stopTyping: () => {},
          stop: async () => {},
        };
      },
    });
    const start = d.handlers.get("session_start")!;

    // Establish the pool rooted at the root session.
    getChildPool(root, "root-session");
    await start({ reason: "startup" }, context(root, "root-session"));
    assert.deepEqual(started, [{ projectRoot: root, sessionId: "root-session" }]);

    // A child session (its id is a registered job) must not start a listener.
    const pool = getChildPool(root, "root-session");
    pool.registry.createJob({
      jobId: "child-a",
      parentSessionId: "root-session",
      rootJobId: "child-a",
      depth: 1,
      sessionId: "child-a",
      status: "running",
      description: "child",
      subagentType: "default",
    });
    await start({ reason: "startup" }, context(root, "child-a"));
    assert.equal(started.length, 1, "child session must not start a Telegram listener");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});