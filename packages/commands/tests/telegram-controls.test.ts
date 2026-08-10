import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  clearTelegramControlState,
  dispatchTelegramControl,
} from "../src/registrations/telegram-controls.ts";

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

test("non-compact commands are not owned by the control handler", async () => {
  const { messages, send } = collectReplies();
  const handled = await dispatchTelegramControl(
    command("goal"),
    { projectRoot: "/tmp/project", chatId: "555", context: context(), sendMessage: send },
  );
  assert.equal(handled, false);
  assert.deepEqual(messages, []);
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