import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  clearTelegramCommandContext,
  clearTelegramControlState,
  dispatchTelegramControl,
  getTelegramCommandContext,
  setTelegramCommandContext,
  takeTelegramCompactionOrigin,
} from "../src/registrations/telegram-controls.ts";
import { takeSessionReload } from "../src/registrations/session-events.ts";

function command(name: string, args = ""): { name: string; args: string } {
  return { name, args };
}

function context(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp/project",
    isIdle: () => true,
    hasPendingMessages: () => false,
    compact: () => {},
    sessionManager: { getSessionId: () => "root-old" },
    ...overrides,
  } as unknown as ExtensionContext;
}

function collectReplies(): { messages: string[]; send: (projectRoot: string, chatId: string, text: string) => Promise<void> } {
  const messages: string[] = [];
  return {
    messages,
    send: async (_projectRoot, _chatId, text) => {
      messages.push(text);
    },
  };
}

test("non-control commands are not owned by the handler", async () => {
  const { messages, send } = collectReplies();
  const handled = await dispatchTelegramControl(
    command("goal"),
    { projectRoot: "/tmp/project", chatId: "555", context: context(), sendMessage: send },
  );
  assert.equal(handled, false);
  assert.deepEqual(messages, []);
});

test("reload invokes the retained command context and marks the session reload", async () => {
  clearTelegramCommandContext("/tmp/reload-project");
  let reloadCalled = 0;
  setTelegramCommandContext("/tmp/reload-project", {
    reload: async () => { reloadCalled += 1; },
  } as unknown as ExtensionCommandContext);
  const { messages, send } = collectReplies();
  const handled = await dispatchTelegramControl(command("reload"), {
    projectRoot: "/tmp/reload-project",
    chatId: "555",
    context: context(),
    sendMessage: send,
  });
  assert.equal(handled, true);
  assert.equal(reloadCalled, 1);
  assert.deepEqual(messages, [
    "♻️ Reloading the active Pi session...",
    "✅ Active Pi session reloaded.",
  ]);
  // The fresh session_start runtime consumes this marker and steers the model,
  // since the pre-reload dispatch frame's `pi` is stale after reload().
  assert.equal(takeSessionReload("/tmp/reload-project"), true);
  clearTelegramCommandContext("/tmp/reload-project");
});

test("failed reload does not mark the session for a reload notification", async () => {
  clearTelegramCommandContext("/tmp/reload-fail-marker");
  setTelegramCommandContext("/tmp/reload-fail-marker", {
    reload: async () => { throw new Error("reload failed"); },
  } as unknown as ExtensionCommandContext);
  const { messages, send } = collectReplies();
  const handled = await dispatchTelegramControl(command("reload"), {
    projectRoot: "/tmp/reload-fail-marker",
    chatId: "555",
    context: context(),
    sendMessage: send,
  });
  assert.equal(handled, true);
  assert.ok(messages[1]?.includes("failed"));
  assert.equal(takeSessionReload("/tmp/reload-fail-marker"), false, "a failed reload must not flag a notification");
  clearTelegramCommandContext("/tmp/reload-fail-marker");
});

test("reload refuses busy or queued sessions", async () => {
  clearTelegramCommandContext("/tmp/reload-busy");
  let reloadCalled = false;
  setTelegramCommandContext("/tmp/reload-busy", {
    reload: async () => { reloadCalled = true; },
  } as unknown as ExtensionCommandContext);
  const busy = collectReplies();
  await dispatchTelegramControl(command("reload"), {
    projectRoot: "/tmp/reload-busy",
    chatId: "555",
    context: context({ isIdle: () => false }),
    sendMessage: busy.send,
  });
  assert.equal(reloadCalled, false);
  assert.ok(busy.messages[0]?.includes("busy"));

  const pending = collectReplies();
  await dispatchTelegramControl(command("reload"), {
    projectRoot: "/tmp/reload-busy",
    chatId: "555",
    context: context({ hasPendingMessages: () => true }),
    sendMessage: pending.send,
  });
  assert.equal(reloadCalled, false);
  assert.ok(pending.messages[0]?.includes("busy"));
  clearTelegramCommandContext("/tmp/reload-busy");
});

test("reload reports unavailable until a command context is available", async () => {
  clearTelegramCommandContext("/tmp/reload-missing");
  const { messages, send } = collectReplies();
  const handled = await dispatchTelegramControl(command("reload"), {
    projectRoot: "/tmp/reload-missing",
    chatId: "555",
    context: context(),
    sendMessage: send,
  });
  assert.equal(handled, true);
  assert.ok(messages[0]?.includes("unavailable"));
});

test("reload reports SDK failures without escaping the Telegram handler", async () => {
  clearTelegramCommandContext("/tmp/reload-failure");
  setTelegramCommandContext("/tmp/reload-failure", {
    reload: async () => { throw new Error("stale context"); },
  } as unknown as ExtensionCommandContext);
  const { messages, send } = collectReplies();
  const handled = await dispatchTelegramControl(command("reload"), {
    projectRoot: "/tmp/reload-failure",
    chatId: "555",
    context: context(),
    sendMessage: send,
  });
  assert.equal(handled, true);
  assert.ok(messages[1]?.includes("stale context"));
  clearTelegramCommandContext("/tmp/reload-failure");
});

test("compact preserves its Telegram origin until post-compaction handling", async () => {
  const { messages, send } = collectReplies();
  let onComplete: (() => void) | undefined;
  const ctx = context({ compact: (options) => { onComplete = options?.onComplete; } });
  await dispatchTelegramControl(command("compact"), {
    projectRoot: "/tmp/compact-origin",
    chatId: "555",
    messageId: 42,
    context: ctx,
    sendMessage: send,
  });
  assert.deepEqual(takeTelegramCompactionOrigin("/tmp/compact-origin", "root-old"), { chatId: "555", messageId: 42 });
  onComplete?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearTelegramControlState();
  assert.deepEqual(messages.filter((message) => message.includes("Compaction started.")), ["🗜 Compaction started."]);
});

test("compact origin is bound to its originating root session", async () => {
  clearTelegramControlState();
  const oldContext = context({ sessionManager: { getSessionId: () => "root-old" } as ExtensionContext["sessionManager"] });
  await dispatchTelegramControl(command("compact"), {
    projectRoot: "/tmp/stale-root",
    chatId: "555",
    messageId: 42,
    context: oldContext,
    sendMessage: async () => undefined,
  });
  assert.equal(takeTelegramCompactionOrigin("/tmp/stale-root", "root-new"), undefined);
  assert.deepEqual(takeTelegramCompactionOrigin("/tmp/stale-root", "root-old"), { chatId: "555", messageId: 42 });
  clearTelegramControlState();
});

test("failed compact discards its pending Telegram origin", async () => {
  clearTelegramControlState();
  let onError: ((error: unknown) => void) | undefined;
  const ctx = context({ compact: (options) => { onError = options?.onError; } });
  await dispatchTelegramControl(command("compact"), {
    projectRoot: "/tmp/compact-failure",
    chatId: "555",
    messageId: 42,
    context: ctx,
    sendMessage: async () => undefined,
  });
  onError?.(new Error("boom"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(takeTelegramCompactionOrigin("/tmp/compact-failure", "root-old"), undefined);
  clearTelegramControlState();
});

test("compact starts a compaction and reports completion", async () => {
  const { messages, send } = collectReplies();
  let compactCalled = false;
  let onComplete: (() => void) | undefined;
  const ctx = context({
    compact: (options) => {
      compactCalled = true;
      onComplete = options?.onComplete;
    },
  });
  const handled = await dispatchTelegramControl(
    command("compact"),
    { projectRoot: "/tmp/project", chatId: "555", context: ctx, sendMessage: send },
  );
  assert.equal(handled, true);
  assert.equal(compactCalled, true, "session compaction is invoked");
  assert.ok(messages.some((m) => m.includes("Compaction started.")), "start notice is sent");
  onComplete?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(messages.some((m) => m.includes("Compaction completed.")), "completion notice is sent");
});

test("compact is refused while the agent is busy or has pending messages", async () => {
  const busy = collectReplies();
  const busyHandled = await dispatchTelegramControl(
    command("compact"),
    { projectRoot: "/tmp/project", chatId: "555", context: context({ isIdle: () => false }), sendMessage: busy.send },
  );
  assert.equal(busyHandled, true);
  assert.ok(busy.messages.some((m) => m.includes("busy")), "busy notice is sent");
  assert.equal(busy.messages.some((m) => m.includes("started")), false, "no compaction starts while busy");

  const pending = collectReplies();
  const pendingHandled = await dispatchTelegramControl(
    command("compact"),
    { projectRoot: "/tmp/project", chatId: "555", context: context({ hasPendingMessages: () => true }), sendMessage: pending.send },
  );
  assert.equal(pendingHandled, true);
  assert.ok(pending.messages.some((m) => m.includes("busy")), "pending-notice is sent");
});

test("a second compact while one is in flight is refused", async () => {
  const { messages, send } = collectReplies();
  let onComplete: (() => void) | undefined;
  const ctx = context({
    compact: (options) => {
      onComplete = options?.onComplete;
    },
  });
  await dispatchTelegramControl(command("compact"), { projectRoot: "/tmp/project", chatId: "555", context: ctx, sendMessage: send });
  const second = await dispatchTelegramControl(command("compact"), { projectRoot: "/tmp/project", chatId: "555", context: ctx, sendMessage: send });
  assert.equal(second, true);
  assert.ok(messages.some((m) => m.includes("busy")), "in-flight compaction refuses a second request");
  onComplete?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearTelegramControlState();
});

function piControl() {
  let level = "medium" as const;
  return {
    setModel: async () => true,
    getThinkingLevel: () => level,
    setThinkingLevel: (next: string) => { level = next as typeof level; },
  };
}

function contextWithPi(pi: ReturnType<typeof piControl>, overrides: Partial<ExtensionContext> = {}) {
  return context({
    modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-x", name: "Claude X" }] },
    model: { provider: "anthropic", id: "claude-x", name: "Claude X" },
    getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 0.5 }),
    getSystemPrompt: () => "SYSTEM",
    ...overrides,
  });
}

test("abort aborts a busy Pi operation and reports", async () => {
  const { messages, send } = collectReplies();
  let aborted = false;
  const ctx = context({ isIdle: () => false, abort: () => { aborted = true; } });
  const handled = await dispatchTelegramControl(
    command("abort"),
    { projectRoot: "/tmp/project", chatId: "555", context: ctx, sendMessage: send },
  );
  assert.equal(handled, true);
  assert.equal(aborted, true);
  assert.ok(messages.some((m) => m.includes("aborted")));
});

test("stop aborts and clears the Telegram queue", async () => {
  const { messages, send } = collectReplies();
  let aborted = false;
  let cleared = false;
  const ctx = context({ isIdle: () => false, abort: () => { aborted = true; } });
  const handled = await dispatchTelegramControl(
    command("stop"),
    { projectRoot: "/tmp/project", chatId: "555", context: ctx, sendMessage: send, clearQueue: () => { cleared = true; } },
  );
  assert.equal(handled, true);
  assert.equal(aborted, true);
  assert.equal(cleared, true);
  assert.ok(messages.some((m) => m.includes("cleared")));
});

test("context reports context usage", async () => {
  const { messages, send } = collectReplies();
  const handled = await dispatchTelegramControl(
    command("context"),
    { projectRoot: "/tmp/project", chatId: "555", context: contextWithPi(piControl()), sendMessage: send },
  );
  assert.equal(handled, true);
  assert.ok(messages.some((m) => m.includes("1,000")));
  assert.ok(messages.some((m) => m.includes("200,000")));
});

test("status reports idle, pending, model, and context", async () => {
  const { messages, send } = collectReplies();
  const handled = await dispatchTelegramControl(
    command("status"),
    { projectRoot: "/tmp/project", chatId: "555", context: contextWithPi(piControl()), sendMessage: send },
  );
  assert.equal(handled, true);
  assert.ok(messages.some((m) => m.includes("idle")));
  assert.ok(messages.some((m) => m.includes("anthropic/claude-x")));
});

test("system_prompt returns the effective system prompt", async () => {
  const { messages, send } = collectReplies();
  const handled = await dispatchTelegramControl(
    command("system_prompt"),
    { projectRoot: "/tmp/project", chatId: "555", context: contextWithPi(piControl()), sendMessage: send, isDevMode: () => true },
  );
  assert.equal(handled, true);
  assert.ok(messages.some((m) => m.includes("SYSTEM")));
});

test("model lists available models and switches on match", async () => {
  const { messages, send } = collectReplies();
  const listHandled = await dispatchTelegramControl(
    command("model"),
    { projectRoot: "/tmp/project", chatId: "555", context: contextWithPi(piControl()), pi: piControl(), sendMessage: send },
  );
  assert.equal(listHandled, true);
  assert.ok(messages.some((m) => m.includes("anthropic/claude-x")));

  const switchMessages: string[] = [];
  const switchHandled = await dispatchTelegramControl(
    command("model", "claude-x"),
    { projectRoot: "/tmp/project", chatId: "555", context: contextWithPi(piControl()), pi: piControl(), sendMessage: async (_p, _c, t) => { switchMessages.push(t); } },
  );
  assert.equal(switchHandled, true);
  assert.ok(switchMessages.some((m) => m.includes("Model set to")));
});

test("system_prompt is blocked unless development mode is enabled", async () => {
  const { messages, send } = collectReplies();
  const handled = await dispatchTelegramControl(
    command("system_prompt"),
    { projectRoot: "/tmp/project", chatId: "555", context: contextWithPi(piControl()), sendMessage: send, isDevMode: () => false },
  );
  assert.equal(handled, true);
  assert.ok(messages.some((m) => m.includes("PI_C2_DEV=1")));
  assert.equal(messages.some((m) => m.includes("SYSTEM")), false);
});

test("thinking shows the level and sets a valid new level", async () => {
  const { messages, send } = collectReplies();
  const showHandled = await dispatchTelegramControl(
    command("thinking"),
    { projectRoot: "/tmp/project", chatId: "555", context: contextWithPi(piControl()), pi: piControl(), sendMessage: send },
  );
  assert.equal(showHandled, true);
  assert.ok(messages.some((m) => m.includes("medium")));

  const setMessages: string[] = [];
  const setHandled = await dispatchTelegramControl(
    command("thinking", "high"),
    { projectRoot: "/tmp/project", chatId: "555", context: contextWithPi(piControl()), pi: piControl(), sendMessage: async (_p, _c, t) => { setMessages.push(t); } },
  );
  assert.equal(setHandled, true);
  assert.ok(setMessages.some((m) => m.includes("high")));
});

test("a thrown compact still reports a failure notice", async () => {
  const { messages, send } = collectReplies();
  const ctx = context({
    compact: () => {
      throw new Error("boom");
    },
  });
  await dispatchTelegramControl(command("compact"), { projectRoot: "/tmp/project", chatId: "555", context: ctx, sendMessage: send });
  assert.ok(messages.some((m) => m.includes("Compaction failed")), "failure notice is sent");
  clearTelegramControlState();
});