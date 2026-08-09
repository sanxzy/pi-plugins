import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getChildPool } from "@xzy-ai/runtime";
import { saveConnectionMarker } from "@xzy-ai/channels";
import { registerTelegramFinalForwarding } from "../src/registrations/telegram-final.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function root(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-telegram-final-"));
}

function writeChannel(cwd: string): void {
  const dir = join(cwd, ".pi", "pi-code");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "channel.json"), JSON.stringify({
    botToken: "123456:SECRET-TOKEN",
    defaultChatId: "42",
    allowedChatIds: ["42"],
    updatedAt: new Date().toISOString(),
  }));
  saveConnectionMarker(cwd, { lastConnection: "telegram", updatedAt: new Date().toISOString() });
}

function context(cwd: string, sessionId: string): ExtensionContext {
  return {
    cwd,
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as ExtensionContext;
}

function registrations() {
  const handlers = new Map<string, Handler>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  return { handlers, pi };
}

function assistant(text: string) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  };
}

test("captures the latest assistant text and forwards it on root settlement", async () => {
  const cwd = root();
  try {
    writeChannel(cwd);
    getChildPool(cwd, "root-session");
    const sent: string[] = [];
    const d = registrations();
    registerTelegramFinalForwarding(d.pi, {
      send: async (_cwd, text) => {
        sent.push(text);
        return { ok: true, sent: 1, failed: 0 };
      },
    });
    const ctx = context(cwd, "root-session");
    await d.handlers.get("message_end")!(assistant("draft"), ctx);
    await d.handlers.get("message_end")!({ type: "message_end", message: { role: "user", content: "ignore" } }, ctx);
    await d.handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
    assert.deepEqual(sent, ["draft"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("does not forward from a child or when the tool already sent the exact text", async () => {
  const cwd = root();
  try {
    writeChannel(cwd);
    const pool = getChildPool(cwd, "root-session");
    pool.registry.createJob({ jobId: "child", parentSessionId: "root-session", rootJobId: "child", depth: 1, sessionId: "child", status: "running", description: "child", subagentType: "default" });
    const sent: string[] = [];
    const d = registrations();
    registerTelegramFinalForwarding(d.pi, {
      send: async (_cwd, text) => {
        sent.push(text);
        return { ok: true, sent: 1, failed: 0 };
      },
      wasSentByTool: (_cwd, text) => text === "already sent",
    });
    await d.handlers.get("message_end")!(assistant("child answer"), context(cwd, "child"));
    await d.handlers.get("agent_settled")!({ type: "agent_settled" }, context(cwd, "child"));
    await d.handlers.get("message_end")!(assistant("already sent"), context(cwd, "root-session"));
    await d.handlers.get("agent_settled")!({ type: "agent_settled" }, context(cwd, "root-session"));
    assert.deepEqual(sent, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("warns on automatic delivery failure without throwing", async () => {
  const cwd = root();
  try {
    writeChannel(cwd);
    getChildPool(cwd, "root-session");
    const warnings: string[] = [];
    const d = registrations();
    registerTelegramFinalForwarding(d.pi, {
      send: async () => ({ ok: false, sent: 0, failed: 1, error: "offline" }),
      warn: (message) => warnings.push(message),
    });
    const ctx = context(cwd, "root-session");
    await d.handlers.get("message_end")!(assistant("final"), ctx);
    await assert.doesNotReject(d.handlers.get("agent_settled")!({ type: "agent_settled" }, ctx));
    assert.deepEqual(warnings, ["Telegram automatic final delivery failed: offline"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
