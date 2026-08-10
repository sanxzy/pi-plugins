import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { approvePairingAt, canonicalProjectRoot, channelConfigFile, channelLogFile, createTelegramInbound, formatTelegramCommandSignature, formatTelegramSignature, readChannelConfig, readChannelRuntime, writeChannelConfig, type TelegramInboundListener } from "@xzy-ai/channels";
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
    subagentType: "test-agent",
  }));
}
import { registerTelegramInbound } from "../src/registrations/telegram-inbound.ts";
import {
  clearTelegramProjectManagers,
  getTelegramMessageHandlerFactory,
} from "../src/registrations/telegram-project.ts";

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

function privateText(updateId: number, fromId: string, text: string, messageId?: number): unknown {
  return {
    update_id: updateId,
    api: { sendMessage: async () => undefined },
    message: {
      chat: { id: 777, type: "private" },
      from: { id: Number(fromId) },
      text,
      ...(messageId === undefined ? {} : { message_id: messageId }),
    },
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

test("agent_start reacts to the latest Telegram user message", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  const { pi, handlers } = registrations();
  const reactions: Array<{ projectRoot: string; chatId: string; messageId?: number }> = [];
  let listener: TelegramInboundListener | undefined;
  registerTelegramInbound(pi, {
    createInbound: (opts) => (listener = createTelegramInbound(opts)),
    reactTelegramMessage: async (projectRoot, origin) => {
      reactions.push({ projectRoot, ...origin });
    },
  });

  await handlers.get("session_start")!({ reason: "startup" }, context(cwd, "root-a"));
  await listener!.handle(privateText(1, "111", "hello", 42));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const agentContext = {
    ...context(cwd, "root-a"),
    sessionManager: {
      getSessionId: () => "root-a",
      getBranch: () => [{ type: "message", message: { role: "user", content: "hello" + formatTelegramSignature("777", 42), timestamp: 1 } }],
    },
  } as unknown as ExtensionContext;
  await handlers.get("agent_start")!({ type: "agent_start" }, agentContext);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(reactions, [{ projectRoot: canonicalProjectRoot(cwd), chatId: "777", messageId: 42 }]);
  clearTelegramProjectManagers();
});

test("agent_start uses the correlated before_agent_start Telegram origin", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  const { pi, handlers } = registrations();
  const reactions: Array<{ chatId: string; messageId?: number }> = [];
  registerTelegramInbound(pi, {
    reactTelegramMessage: async (_projectRoot, origin) => { reactions.push(origin); },
  });
  const beforeContext = context(cwd, "root-a");
  await handlers.get("before_agent_start")?.({
    type: "before_agent_start",
    prompt: "hello" + formatTelegramSignature("777", 55),
  }, beforeContext);
  const agentContext = {
    ...context(cwd, "root-a"),
    sessionManager: { getSessionId: () => "root-a", getBranch: () => [] },
  } as unknown as ExtensionContext;
  await handlers.get("agent_start")?.({ type: "agent_start" }, agentContext);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(reactions, [{ chatId: "777", messageId: 55 }]);
});

test("agent_start acknowledgements are deduplicated for one agent run", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  const { pi, handlers } = registrations();
  let reactionCount = 0;
  registerTelegramInbound(pi, {
    reactTelegramMessage: async () => { reactionCount += 1; },
  });
  const agentContext = {
    ...context(cwd, "root-a"),
    sessionManager: {
      getSessionId: () => "root-a",
      getBranch: () => [{ type: "message", message: { role: "user", content: "hello" + formatTelegramSignature("777", 42) } }],
    },
  } as unknown as ExtensionContext;
  await handlers.get("agent_start")?.({ type: "agent_start" }, agentContext);
  await handlers.get("agent_start")?.({ type: "agent_start" }, agentContext);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reactionCount, 1);
});

test("agent_start reaction failure is logged and does not block", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  const { pi, handlers } = registrations();
  let logged: unknown;
  registerTelegramInbound(pi, {
    reactTelegramMessage: async () => { throw new Error("Telegram rejected reaction"); },
    onReactionError: (error) => { logged = error; },
  });
  const agentContext = {
    ...context(cwd, "root-a"),
    sessionManager: {
      getSessionId: () => "root-a",
      getBranch: () => [{ type: "message", message: { role: "user", content: "hello" + formatTelegramSignature("777", 42) } }],
    },
  } as unknown as ExtensionContext;
  await handlers.get("agent_start")?.({ type: "agent_start" }, agentContext);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(logged, "reaction failure is logged");
});

test("child before_agent_start and agent_start never acknowledge Telegram", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  markChild(cwd, "child-session");
  const { pi, handlers } = registrations();
  let reactionCount = 0;
  registerTelegramInbound(pi, {
    reactTelegramMessage: async () => { reactionCount += 1; },
  });
  const childContext = {
    ...context(cwd, "child-session"),
    sessionManager: {
      getSessionId: () => "child-session",
      getBranch: () => [{ type: "message", message: { role: "user", content: "hello" + formatTelegramSignature("777", 42) } }],
    },
  } as unknown as ExtensionContext;
  await handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: "hello" + formatTelegramSignature("777", 42) }, childContext);
  await handlers.get("agent_start")?.({ type: "agent_start" }, childContext);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reactionCount, 0);
});

test("default reaction failures are written to the production channel log", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  const { pi, handlers } = registrations();
  registerTelegramInbound(pi, {
    reactTelegramMessage: async () => { throw new Error("Telegram rejected reaction"); },
  });
  const agentContext = {
    ...context(cwd, "root-a"),
    sessionManager: {
      getSessionId: () => "root-a",
      getBranch: () => [{ type: "message", message: { role: "user", content: "hello" + formatTelegramSignature("777", 42) } }],
    },
  } as unknown as ExtensionContext;
  await handlers.get("agent_start")?.({ type: "agent_start" }, agentContext);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const log = readFileSync(channelLogFile(cwd, "root-a"), "utf8");
  assert.match(log, /telegram_reaction_failed/);
  assert.match(log, /Telegram rejected reaction/);
});

test("agent_start reaction timeout is logged and does not block", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  const { pi, handlers } = registrations();
  let logged: unknown;
  registerTelegramInbound(pi, {
    reactionTimeoutMs: 5,
    reactTelegramMessage: async () => new Promise<void>(() => undefined),
    onReactionError: (error) => { logged = error; },
  });
  const agentContext = {
    ...context(cwd, "root-a"),
    sessionManager: {
      getSessionId: () => "root-a",
      getBranch: () => [{ type: "message", message: { role: "user", content: "hello" + formatTelegramSignature("777", 42) } }],
    },
  } as unknown as ExtensionContext;
  const started = Date.now();
  await handlers.get("agent_start")?.({ type: "agent_start" }, agentContext);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(Date.now() - started < 100, "agent_start does not wait on Telegram");
  assert.ok(logged, "reaction timeout is logged");
});

test("agent_start does not react to a TUI-originated latest user message", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  const { pi, handlers } = registrations();
  let reactionCount = 0;
  registerTelegramInbound(pi, {
    reactTelegramMessage: async () => { reactionCount += 1; },
  });
  const agentContext = {
    ...context(cwd, "root-a"),
    sessionManager: {
      getSessionId: () => "root-a",
      getBranch: () => [{ type: "message", message: { role: "user", content: "local prompt", timestamp: 1 } }],
    },
  } as unknown as ExtensionContext;
  await handlers.get("agent_start")!({ type: "agent_start" }, agentContext);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reactionCount, 0);
});

test("first-time setup keeps the inbound handler when session starts before channel config exists", async () => {
  const cwd = projectRoot();
  const { pi, handlers } = registrations();
  registerTelegramInbound(pi);

  // This is the setup sequence that previously lost inbound routing: the root
  // session started before channel.json existed, then setup created the first
  // Telegram connection through the already-created project manager.
  await handlers.get("session_start")!({ reason: "startup" }, context(cwd, "root-a"));
  mkdirSync(dirname(channelConfigFile(cwd)), { recursive: true });
  writeFileSync(channelConfigFile(cwd), JSON.stringify({
    token: "123456789:ABCDEFGHIJKLMNOPQRSTUVWX",
    approvedUserIds: [],
  }), "utf8");

  const factory = getTelegramMessageHandlerFactory(cwd);
  assert.equal(typeof factory, "function", "the manager retains an inbound handler factory");
  const handler = factory?.({ token: "123456789:ABCDEFGHIJKLMNOPQRSTUVWX", approvedUserIds: [] });
  await handler?.(privateText(1, "222", "hello"));

  const config = readChannelConfig(cwd);
  assert.equal(config.ok, true);
  if (config.ok) {
    assert.equal(config.value.pendingPairings?.length, 1);
    assert.equal(config.value.pendingPairings?.[0]?.userId, "222");
  }
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

test("a recognized slash command is dispatched natively with a compact signature", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  const { pi, handlers, sent } = registrations();
  let listener: TelegramInboundListener | undefined;
  registerTelegramInbound(pi, {
    createInbound: (opts) => (listener = createTelegramInbound(opts)),
    expandCommand: (name, args) => (name === "goal" ? `GOAL_WORKFLOW+${args}` : undefined),
  });

  await handlers.get("session_start")!({ reason: "startup" }, context(cwd, "root-a"));
  await listener!.handle(privateText(1, "111", "/goal 10s testing"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(sent.length, 1);
  assert.equal(sent[0], "GOAL_WORKFLOW+10s testing" + formatTelegramCommandSignature("777"), "expanded content plus compact signature, no long footer");
  assert.doesNotMatch(sent[0], /Be indifferent/);
  clearTelegramProjectManagers();
});

test("an unknown slash command stays literal text with the full signature", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  const { pi, handlers, sent } = registrations();
  let listener: TelegramInboundListener | undefined;
  registerTelegramInbound(pi, {
    createInbound: (opts) => (listener = createTelegramInbound(opts)),
    expandCommand: () => undefined,
  });

  await handlers.get("session_start")!({ reason: "startup" }, context(cwd, "root-a"));
  await listener!.handle(privateText(1, "111", "/unknown args"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(sent.length, 1);
  assert.equal(sent[0], "/unknown args" + formatTelegramSignature("777"));
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