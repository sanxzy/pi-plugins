import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { approvePairingAt, canonicalProjectRoot, channelConfigFile, channelLogFile, clearTelegramChoiceState, createTelegramChoice, createTelegramInbound, formatTelegramCommandSignature, formatTelegramSignature, readChannelConfig, readChannelRuntime, writeChannelConfig, type TelegramInboundListener } from "@xzy-ai/channels";
import { getChildPool, settingsConfigPath } from "@xzy-ai/runtime";
import { createJob } from "@xzy-ai/core";
import { TELEGRAM_OPERATIONS, createSessionLogger, runWithLogContext } from "@xzy-ai/observability";

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
import { clearTelegramControlState } from "../src/registrations/telegram-controls.ts";
import {
  clearTelegramProjectManagers,
  getTelegramCallbackQueryHandlerFactory,
  getTelegramMessageHandlerFactory,
} from "../src/registrations/telegram-project.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-c2-telegram-inbound-"));
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

test("session_compact reacts to the pending /compact origin after success", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  clearTelegramControlState();
  const { pi, handlers } = registrations();
  const reactions: Array<{ chatId: string; messageId?: number }> = [];
  let listener: TelegramInboundListener | undefined;
  registerTelegramInbound(pi, {
    createInbound: (options) => (listener = createTelegramInbound(options)),
    reactTelegramMessage: async (_projectRoot, origin) => { reactions.push(origin); },
  });
  const agentContext = {
    ...context(cwd, "root-a"),
    isIdle: () => true,
    hasPendingMessages: () => false,
    compact: () => {},
    sessionManager: { getSessionId: () => "root-a", getBranch: () => [] },
  } as unknown as ExtensionContext;
  await handlers.get("session_start")?.({ reason: "startup" }, agentContext);
  await listener!.handle(privateText(1, "111", "/compact", 42));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await handlers.get("session_compact")?.({ type: "session_compact", reason: "manual", fromExtension: true }, agentContext);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(reactions, [{ chatId: "777", messageId: 42 }]);
  clearTelegramControlState();
  clearTelegramProjectManagers();
});

test("session_compact ignores threshold compaction and consumes manual origin once", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  clearTelegramControlState();
  const { pi, handlers } = registrations();
  const reactions: Array<{ chatId: string; messageId?: number }> = [];
  let listener: TelegramInboundListener | undefined;
  registerTelegramInbound(pi, {
    createInbound: (options) => (listener = createTelegramInbound(options)),
    reactTelegramMessage: async (_projectRoot, origin) => { reactions.push(origin); },
  });
  const agentContext = {
    ...context(cwd, "root-a"),
    isIdle: () => true,
    hasPendingMessages: () => false,
    compact: () => {},
    sessionManager: { getSessionId: () => "root-a", getBranch: () => [] },
  } as unknown as ExtensionContext;
  await handlers.get("session_start")?.({ reason: "startup" }, agentContext);
  await listener!.handle(privateText(1, "111", "/compact", 42));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await handlers.get("session_compact")?.({ type: "session_compact", reason: "threshold", fromExtension: false }, agentContext);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(reactions, []);
  await handlers.get("session_compact")?.({ type: "session_compact", reason: "manual", fromExtension: true }, agentContext);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(reactions, [{ chatId: "777", messageId: 42 }]);
  await handlers.get("session_compact")?.({ type: "session_compact", reason: "manual", fromExtension: true }, agentContext);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(reactions, [{ chatId: "777", messageId: 42 }]);
  clearTelegramControlState();
  clearTelegramProjectManagers();
});

test("replacement root cannot consume an old root's pending compact origin", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  clearTelegramControlState();
  const { pi, handlers } = registrations();
  const reactions: Array<{ chatId: string; messageId?: number }> = [];
  let listener: TelegramInboundListener | undefined;
  registerTelegramInbound(pi, {
    createInbound: (options) => (listener = createTelegramInbound(options)),
    reactTelegramMessage: async (_projectRoot, origin) => { reactions.push(origin); },
  });
  const oldRoot = {
    ...context(cwd, "root-old"),
    isIdle: () => true,
    hasPendingMessages: () => false,
    compact: () => {},
    sessionManager: { getSessionId: () => "root-old", getBranch: () => [] },
  } as unknown as ExtensionContext;
  await handlers.get("session_start")?.({ reason: "startup" }, oldRoot);
  await listener!.handle(privateText(1, "111", "/compact", 42));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const replacementRoot = {
    ...oldRoot,
    sessionManager: { getSessionId: () => "root-new", getBranch: () => [] },
  } as unknown as ExtensionContext;
  await handlers.get("session_compact")?.({ type: "session_compact", reason: "manual", fromExtension: true }, replacementRoot);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(reactions, []);
  await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "new" }, oldRoot);
  clearTelegramControlState();
  clearTelegramProjectManagers();
});

test("unrelated native controls remain reaction-free", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  clearTelegramControlState();
  const { pi, handlers } = registrations();
  const reactions: Array<{ chatId: string; messageId?: number }> = [];
  let listener: TelegramInboundListener | undefined;
  registerTelegramInbound(pi, {
    createInbound: (options) => (listener = createTelegramInbound(options)),
    reactTelegramMessage: async (_projectRoot, origin) => { reactions.push(origin); },
  });
  const root = {
    ...context(cwd, "root-a"),
    isIdle: () => true,
    hasPendingMessages: () => false,
    compact: () => {},
    sessionManager: { getSessionId: () => "root-a", getBranch: () => [] },
  } as unknown as ExtensionContext;
  await handlers.get("session_start")?.({ reason: "startup" }, root);
  for (const name of ["/abort", "/stop", "/model", "/thinking"]) {
    await listener!.handle(privateText(Math.random() * 10000, "111", name, 50));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await handlers.get("session_compact")?.({ type: "session_compact", reason: "manual", fromExtension: true }, root);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(reactions, []);
  clearTelegramControlState();
  clearTelegramProjectManagers();
});

test("a choice callback is answered promptly and disables its keyboard", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  clearTelegramChoiceState();
  const { pi, handlers, sent } = registrations();
  const answered: string[] = [];
  const edited: unknown[] = [];
  let callbackHandler: ((context: unknown) => Promise<unknown> | unknown) | undefined;
  registerTelegramInbound(pi, {
    createInbound: (opts) => createTelegramInbound(opts),
  });
  const root = { ...context(cwd, "root-a"), sessionManager: { getSessionId: () => "root-a", getBranch: () => [] } } as unknown as ExtensionContext;
  await handlers.get("session_start")?.({ reason: "startup" }, root);
  const state = createTelegramChoice({ projectRoot: canonicalProjectRoot(cwd), sessionId: "root-a", chatId: "777", senderId: "111", question: "Proceed?", choices: [{ label: "Yes", value: "approved" }], expiresAt: Date.now() + 60_000 });
  const callbackFactory = getTelegramCallbackQueryHandlerFactory(cwd);
  callbackHandler = callbackFactory?.({ token: "x", approvedUserIds: ["111"] });
  await callbackHandler?.({
    callbackQuery: { id: "cq1", data: state.callbackData[0]!, from: { id: 111 }, message: { chat: { id: 777 }, message_id: 10 } },
    api: {
      answerCallbackQuery: async (id: string) => { answered.push(id); },
      editMessageReplyMarkup: async (_chat: string, _id: number, other: unknown) => { edited.push(other); },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(answered, ["cq1"]);
  assert.deepEqual(edited, [{ reply_markup: { inline_keyboard: [] } }]);
  assert.equal(sent.length, 1);
  clearTelegramChoiceState();
  clearTelegramProjectManagers();
});

test("choice callback processing emits a correlated telemetry boundary", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  clearTelegramChoiceState();
  const { pi, handlers } = registrations();
  registerTelegramInbound(pi, { createInbound: (opts) => createTelegramInbound(opts) });
  const root = { ...context(cwd, "root-a"), sessionManager: { getSessionId: () => "root-a", getBranch: () => [] } } as unknown as ExtensionContext;
  await handlers.get("session_start")?.({ reason: "startup" }, root);
  const state = createTelegramChoice({
    projectRoot: canonicalProjectRoot(cwd), sessionId: "root-a", chatId: "777", senderId: "111",
    question: "Proceed?", choices: [{ label: "Yes", value: "approved" }], expiresAt: Date.now() + 60_000,
  });
  const callback = getTelegramCallbackQueryHandlerFactory(cwd)?.({ token: "x", approvedUserIds: ["111"] });
  assert.ok(callback);
  const logDir = mkdtempSync(join(tmpdir(), "pi-c2-choice-log-"));
  const logger = createSessionLogger({
    projectId: "project",
    rootSessionId: "root-a",
    eventsPath: join(logDir, "events.jsonl"),
    errorsPath: join(logDir, "errors.jsonl"),
  });
  await runWithLogContext(logger, () => callback({
    callbackQuery: {
      id: "cq-log", data: state.callbackData[0]!, from: { id: 111 },
      message: { chat: { id: 777 }, message_id: 10 },
    },
  }));
  const records = readFileSync(join(logDir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const choiceRecords = records.filter((record) => record.operation === TELEGRAM_OPERATIONS.CHOICE_CONSUME);
  assert.deepEqual(choiceRecords.map((record) => record.phase), ["before", "after"]);
  assert.equal(choiceRecords[0]?.correlationId, choiceRecords[1]?.correlationId);
  clearTelegramChoiceState();
  clearTelegramProjectManagers();
});

test("session shutdown invalidates pending choice callbacks for that root session", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  clearTelegramChoiceState();
  const { pi, handlers, sent } = registrations();
  registerTelegramInbound(pi, {
    createInbound: (opts) => createTelegramInbound(opts),
  });
  const root = { ...context(cwd, "root-a"), sessionManager: { getSessionId: () => "root-a", getBranch: () => [] } } as unknown as ExtensionContext;
  await handlers.get("session_start")?.({ reason: "startup" }, root);
  const state = createTelegramChoice({ projectRoot: canonicalProjectRoot(cwd), sessionId: "root-a", chatId: "777", senderId: "111", question: "Proceed?", choices: [{ label: "Yes", value: "approved" }], expiresAt: Date.now() + 60_000 });
  const callbackFactory = getTelegramCallbackQueryHandlerFactory(cwd);
  const callback = callbackFactory?.({ token: "x", approvedUserIds: ["111"] });
  // Simulate a shutdown of the owning root session through the lifecycle hook.
  await handlers.get("session_shutdown")?.({ reason: "shutdown" }, root);
  await callback?.({ callbackQuery: {
    id: "cq1", data: state.callbackData[0]!, from: { id: 111 },
    message: { chat: { id: 777 }, message_id: 10 },
  } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent.length, 0, "no agent turn is injected after shutdown invalidates the choice");
  clearTelegramChoiceState();
  clearTelegramProjectManagers();
});

test("a valid choice callback is consumed once and injected into the root session", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  clearTelegramChoiceState();
  const { pi, handlers, sent } = registrations();
  let callbackHandler: ((context: unknown) => Promise<unknown> | unknown) | undefined;
  let listener: TelegramInboundListener | undefined;
  registerTelegramInbound(pi, {
    createInbound: (opts) => (listener = createTelegramInbound(opts)),
  });
  const agentContext = {
    ...context(cwd, "root-a"),
    sessionManager: { getSessionId: () => "root-a", getBranch: () => [] },
  } as unknown as ExtensionContext;
  await handlers.get("session_start")?.({ reason: "startup" }, agentContext);
  const state = createTelegramChoice({
    projectRoot: canonicalProjectRoot(cwd), sessionId: "root-a", chatId: "777", senderId: "111",
    question: "Proceed?", choices: [{ label: "Yes", value: "approved" }], expiresAt: Date.now() + 60_000,
  });
  const factory = getTelegramMessageHandlerFactory(cwd);
  assert.equal(typeof factory, "function", "message handler factory is registered");
  const callbackFactory = getTelegramCallbackQueryHandlerFactory(cwd);
  assert.equal(typeof callbackFactory, "function", "callback handler factory is registered");
  const callback = callbackFactory?.({ token: "123456789:ABCDEFGHIJKLMNOPQRSTUVWX", approvedUserIds: ["111"] });
  assert.equal(typeof callback, "function", "callback handler is registered");
  await callback?.({ callbackQuery: {
    id: "cq1", data: state.callbackData[0]!, from: { id: 111 },
    message: { chat: { id: 777 }, message_id: 10 },
  } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent.length, 1, "one contextual follow-up is injected");
  assert.match(sent[0]!, /Proceed\?/);
  assert.match(sent[0]!, /approved/);
  // A duplicate tap produces no second turn.
  await callback?.({ callbackQuery: {
    id: "cq2", data: state.callbackData[0]!, from: { id: 111 },
    message: { chat: { id: 777 }, message_id: 10 },
  } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent.length, 1, "duplicate tap does not create a second turn");
  clearTelegramChoiceState();
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

test("fire-and-forget reaction acknowledgement has its own telemetry boundary (H9)", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  const logDir = mkdtempSync(join(tmpdir(), "pi-c2-reaction-log-"));
  const logger = createSessionLogger({ projectId: "project", rootSessionId: "root-a", eventsPath: join(logDir, "events.jsonl"), errorsPath: join(logDir, "errors.jsonl") });
  const { pi, handlers } = registrations();
  registerTelegramInbound(pi, { reactTelegramMessage: async () => undefined });
  const agentContext = {
    ...context(cwd, "root-a"),
    sessionManager: { getSessionId: () => "root-a", getBranch: () => [{ type: "message", message: { role: "user", content: "hello" + formatTelegramSignature("777", 42) } }] },
  } as unknown as ExtensionContext;
  await runWithLogContext(logger, async () => {
    await handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: "hello" + formatTelegramSignature("777", 42) }, agentContext);
    await handlers.get("agent_start")?.({ type: "agent_start" }, agentContext);
    await new Promise((resolve) => setImmediate(resolve));
  });
  const records = readFileSync(join(logDir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const reactionRecords = records.filter((record) => record.operation === TELEGRAM_OPERATIONS.REACTION_ACK);
  assert.deepEqual(reactionRecords.map((record) => record.phase), ["before", "after"]);
  assert.deepEqual(reactionRecords.map((record) => record.parameters), [{ chatId: "777" }, { chatId: "777" }], "reaction telemetry carries chat id only, never message id, tokens, or URLs");
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

test("centralized reaction timeout is used when no per-registration override is supplied", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  mkdirSync(dirname(settingsConfigPath()), { recursive: true });
  writeFileSync(settingsConfigPath(), JSON.stringify({ commands: { telegram: { reactionTimeoutMs: 5 } } }), "utf8");
  const { pi, handlers } = registrations();
  let logged: unknown;
  registerTelegramInbound(pi, {
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
  await handlers.get("agent_start")?.({ type: "agent_start" }, agentContext);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(logged, "centralized reaction timeout is logged");
});

test("invalid centralized reaction timeout falls through to the safe default", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  mkdirSync(dirname(settingsConfigPath()), { recursive: true });
  writeFileSync(settingsConfigPath(), JSON.stringify({ commands: { telegram: { reactionTimeoutMs: 0 } } }), "utf8");
  const { pi, handlers } = registrations();
  let logged: unknown;
  registerTelegramInbound(pi, {
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
  await handlers.get("agent_start")?.({ type: "agent_start" }, agentContext);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(logged, undefined, "the invalid zero setting must not create an immediate zero-timeout path");
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

test("a TUI prompt after a prior Telegram message does not react to the stale origin", async () => {
  const cwd = projectRoot();
  writeConfig(cwd);
  const { pi, handlers } = registrations();
  let reactionCount = 0;
  registerTelegramInbound(pi, {
    reactTelegramMessage: async () => { reactionCount += 1; },
  });
  // before_agent_start observes a plain/TUI prompt (no Telegram signature), but
  // the branch still contains an older Telegram-signed user message.
  await handlers.get("before_agent_start")?.(
    { type: "before_agent_start", prompt: "local prompt" },
    context(cwd, "root-a"),
  );
  const agentContext = {
    ...context(cwd, "root-a"),
    sessionManager: {
      getSessionId: () => "root-a",
      getBranch: () => [
        { type: "message", message: { role: "user", content: "hello" + formatTelegramSignature("777", 42) } },
      ],
    },
  } as unknown as ExtensionContext;
  await handlers.get("agent_start")?.({ type: "agent_start" }, agentContext);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reactionCount, 0);
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