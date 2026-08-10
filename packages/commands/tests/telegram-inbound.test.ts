import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { approvePairingAt, channelConfigFile, createTelegramInbound, formatTelegramSignature, readChannelConfig, readChannelRuntime, writeChannelConfig, type TelegramInboundListener } from "@xzy-ai/channels";
import { getChildPool } from "@xzy-ai/runtime";
import { createJob } from "@xzy-ai/core";

function markChild(cwd: string, sessionId: string): void {
  const pool = getChildPool(cwd, "root-a");
  pool.registry.createJob(createJob({
    jobId: sessionId,
    parentSessionId: "root-a",
    rootJobId: sessionId,
    depth: 0,
    sessionId,
    status: "running",
    description: sessionId,
    subagentType: "default",
  }));
}
import { registerTelegramInbound } from "../src/registrations/telegram-inbound.ts";
import { clearTelegramProjectManagers } from "../src/registrations/telegram-project.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-telegram-inbound-"));
}

function writeConfig(cwd: string): void {
  const file = channelConfigFile(cwd);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ token: "123456789:ABCDEFGHIJKLMNOPQRSTUVWX", approvedUserIds: ["111"] }), "utf8");
}

function registrations(): { pi: ExtensionAPI; handlers: Map<string, Handler>; sent: string[]; deliveryModes: string[] } {
  const handlers = new Map<string, Handler>();
  const sent: string[] = [];
  const deliveryModes: string[] = [];
  return {
    sent,
    deliveryModes,
    handlers,
    pi: {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      sendUserMessage(content: string | { type: string; text: string }[], options?: { deliverAs?: string }) {
        const text = typeof content === "string" ? content : content.map((p) => p.text).join("");
        sent.push(text);
        if (options?.deliverAs) deliveryModes.push(options.deliverAs);
      },
    } as unknown as ExtensionAPI,
  };
}

function context(cwd: string, sessionId: string, idle = true): ExtensionContext {
  return {
    mode: "tui",
    hasUI: true,
    cwd,
    isIdle: () => idle,
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as ExtensionContext;
}

function privateText(updateId: number, fromId: string, text: string): unknown {
  return {
    update_id: updateId,
    api: { sendMessage: async () => undefined },
    message: { chat: { id: 777, type: "private" }, from: { id: Number(fromId) }, text },
  };
}

test("root session start delivers accepted text as a follow-up with the exact signature and persists the update cursor", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  const { pi, handlers, sent, deliveryModes } = registrations();
  let listener: TelegramInboundListener | undefined;
  registerTelegramInbound(pi, {
    createInbound: (opts) => {
      listener = createTelegramInbound(opts);
      return listener;
    },
  });

  await handlers.get("session_start")!({ reason: "startup" }, context(cwd, "root-a"));
  await listener!.handle(privateText(1, "111", "hello"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(sent.length, 1, "one Telegram message is injected");
  assert.equal(sent[0], "hello" + formatTelegramSignature("777"), "exact signature is appended");
  const runtime = readChannelRuntime(cwd);
  assert.equal(runtime.ok, true);
  if (runtime.ok) assert.equal(runtime.value.lastUpdateId, 1);
  clearTelegramProjectManagers();
});

test("child sessions never start an inbound listener or inject follow-ups", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  const { pi, handlers, sent } = registrations();
  let listenerCreated = false;
  registerTelegramInbound(pi, {
    createInbound: (opts) => {
      listenerCreated = true;
      return createTelegramInbound(opts);
    },
  });

  // A child session id that is also a job in the pool is not the root.
  markChild(cwd, "child-session");
  await handlers.get("session_start")!({ reason: "startup" }, context(cwd, "child-session"));
  assert.equal(listenerCreated, false, "no listener is created for a child session");
  assert.equal(sent.length, 0, "no follow-up is injected for a child session");
  clearTelegramProjectManagers();
});

test("a busy agent is steered immediately with deliverAs steer, preserving FIFO", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  const { pi, handlers, sent, deliveryModes } = registrations();
  let listener: TelegramInboundListener | undefined;
  registerTelegramInbound(pi, {
    createInbound: (opts) => (listener = createTelegramInbound(opts)),
  });

  await handlers.get("session_start")!({ reason: "startup" }, context(cwd, "root-a"));
  // The agent is busy; accepted Telegram messages must steer it right away.
  const busyCtx = context(cwd, "root-a", false);
  await listener!.handle(privateText(1, "111", "one"));
  await listener!.handle(privateText(2, "111", "two"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, [
    "one" + formatTelegramSignature("777"),
    "two" + formatTelegramSignature("777"),
  ], "each busy message is steered in arrival order");
  assert.deepEqual(deliveryModes, ["steer", "steer"], "busy messages use steer delivery");
  clearTelegramProjectManagers();
});

test("an idle agent also receives the message as a steer", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  const { pi, handlers, sent, deliveryModes } = registrations();
  let listener: TelegramInboundListener | undefined;
  registerTelegramInbound(pi, {
    createInbound: (opts) => (listener = createTelegramInbound(opts)),
  });

  await handlers.get("session_start")!({ reason: "startup" }, context(cwd, "root-a"));
  await listener!.handle(privateText(1, "111", "hello"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(sent.length, 1, "one idle message is delivered");
  assert.deepEqual(deliveryModes, ["steer"], "an idle message is also delivered as a steer");
  clearTelegramProjectManagers();
});

test("an unauthorized DM creates a pairing request and is never delivered; approval unlocks the next DM", async () => {
  const cwd = projectRoot();
  mkdirSync(dirname(channelConfigFile(cwd)), { recursive: true });
  writeFileSync(channelConfigFile(cwd), JSON.stringify({ token: "123456789:ABCDEFGHIJKLMNOPQRSTUVWX", approvedUserIds: [] }), "utf8");
  const { pi, handlers, sent } = registrations();
  let listener: TelegramInboundListener | undefined;
  registerTelegramInbound(pi, {
    createInbound: (opts) => (listener = createTelegramInbound(opts)),
  });

  await handlers.get("session_start")!({ reason: "startup" }, context(cwd, "root-a"));
  await listener!.handle(privateText(1, "222", "challenged"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent.length, 0, "unauthorized text never enters the parent");

  // The operator approves the pending request via setup; the listener refreshes.
  const config = readChannelConfig(cwd);
  assert.equal(config.ok, true);
  if (config.ok) {
    assert.equal(config.value.pendingPairings?.length, 1);
    const approved = approvePairingAt(config.value, 1);
    assert.equal(approved.ok, true);
    if (approved.ok) {
      writeChannelConfig(cwd, approved.config);
      listener!.setApprovedUserIds(approved.config.approvedUserIds);
    }
  }

  await listener!.handle(privateText(2, "222", "later"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sent, ["later" + formatTelegramSignature("777")], "the post-approval DM is delivered");
  clearTelegramProjectManagers();
});

test("session shutdown stops the inbound listener", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  const { pi, handlers, sent } = registrations();
  let stopped = false;
  registerTelegramInbound(pi, {
    createInbound: (opts) => {
      const listener = createTelegramInbound(opts);
      const originalStop = listener.stop;
      listener.stop = () => { stopped = true; originalStop.call(listener); };
      return listener;
    },
  });

  await handlers.get("session_start")!({ reason: "startup" }, context(cwd, "root-a"));
  await handlers.get("session_shutdown")!({ reason: "quit" }, context(cwd, "root-a"));
  assert.equal(stopped, true, "the listener stops on shutdown");
  clearTelegramProjectManagers();
});