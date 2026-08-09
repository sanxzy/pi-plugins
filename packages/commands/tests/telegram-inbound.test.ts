import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTelegramInbound } from "../src/registrations/telegram-inbound.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-code-inbound-"));
  return root;
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

test("registerTelegramInbound registers session_start and session_shutdown handlers", () => {
  const root = projectRoot();
  try {
    const d = registrations();
    registerTelegramInbound(d.pi);
    assert.equal(d.handlers.has("session_start"), true);
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
    await d.handlers.get("session_start")!({ reason: "startup" }, context(root, "root-a"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});