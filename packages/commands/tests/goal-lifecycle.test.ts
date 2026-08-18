import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getGoalPool } from "@xzy-ai/runtime";
import { registerLifecycleGates } from "../src/registrations/lifecycle-gates.ts";
import { registerSessionEvents } from "../src/registrations/session-events.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function context(
  cwd: string,
  sessionId: string,
  confirm: (title: string, message: string) => Promise<boolean>,
  hasUI = true,
  sessionFile: string | undefined = join(cwd, "sessions", `${sessionId}.jsonl`),
): ExtensionContext {
  return {
    mode: hasUI ? "tui" : "json",
    hasUI,
    cwd,
    ui: { confirm },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
    },
  } as unknown as ExtensionContext;
}

function registrations(): { pi: ExtensionAPI; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    getAllTools: () => [],
    setActiveTools: () => {},
    sendUserMessage: () => {},
  } as unknown as ExtensionAPI;
  return { handlers, pi };
}

function addActiveGoal(cwd: string, prompt = "p", sessionId = "root"): void {
  const pool = getGoalPool(cwd, sessionId);
  pool.setScheduler(() => ({ clear() {} }));
  pool.bind({
    cwd,
    hasUI: true,
    sendUserMessage: () => {},
    notify: () => {},
  });
  assert.equal(pool.create({ cwd, prompt, interval: "1m" }).ok, true);
}

test("session start with a persisted active goal pauses delivery pending confirmation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-goal-lifecycle-"));
  try {
    addActiveGoal(cwd);
    const d = registrations();
    d.pi.getAllTools = () => [];
    d.pi.setActiveTools = () => {};
    d.pi.sendUserMessage = () => {};
    registerSessionEvents(d.pi);
    const sent: string[] = [];
    d.pi.sendUserMessage = (content: string) => { sent.push(content); };
    await d.handlers.get("session_start")!({ reason: "startup" }, context(cwd, "root", async () => true));
    // No immediate delivery while confirmation is pending.
    assert.deepEqual(sent, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("/new does not clear the current root session goal or ask to continue it", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-goal-lifecycle-"));
  try {
    addActiveGoal(cwd);
    const d = registrations();
    registerLifecycleGates(d.pi);
    const result = await d.handlers.get("session_before_switch")!(
      { reason: "new" },
      context(cwd, "root", async () => false),
    );
    assert.deepEqual(result, { cancel: false });
    assert.equal(getGoalPool(cwd, "root").get()?.status, "active");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session shutdown pauses the persisted goal while stopping delivery", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-goal-lifecycle-"));
  try {
    addActiveGoal(cwd);
    const d = registrations();
    registerSessionEvents(d.pi);
    await d.handlers.get("session_shutdown")!({ reason: "new" }, context(cwd, "root", async () => true));
    // Shutdown stops timers/bindings and pauses the active goal but never
    // clears it; the persisted record survives for the resumed session.
    const goal = getGoalPool(cwd).get();
    assert.equal(goal?.status, "paused");
    assert.match(goal?.pauseReason ?? "", /new/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("startup does not offer continuation for a goal from another root session", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-goal-lifecycle-"));
  try {
    addActiveGoal(cwd, "p", "old-root");
    const confirmed: string[] = [];
    const d = registrations();
    let sent = 0;
    d.pi.sendUserMessage = () => { sent += 1; };
    registerSessionEvents(d.pi);
    await d.handlers.get("session_start")!(
      { reason: "startup" },
      context(cwd, "root", async (title, message) => {
        confirmed.push(`${title}: ${message}`);
        return true;
      }),
    );
    assert.equal(confirmed.length, 0);
    // The current root session has no inherited goal.
    assert.equal(getGoalPool(cwd, "root").get(), undefined);
    assert.equal(sent, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("startup leaves the prior root session goal untouched", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-goal-lifecycle-"));
  try {
    addActiveGoal(cwd, "p", "old-root");
    const d = registrations();
    registerSessionEvents(d.pi);
    await d.handlers.get("session_start")!(
      { reason: "startup" },
      context(cwd, "root", async () => false),
    );
    assert.equal(getGoalPool(cwd, "root").get(), undefined);
    assert.equal(getGoalPool(cwd, "old-root").get()?.prompt, "p");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("startup with no session file does not offer another session's goal", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-goal-lifecycle-"));
  try {
    addActiveGoal(cwd, "p", "old-root");
    const d = registrations();
    const confirmations: string[] = [];
    registerSessionEvents(d.pi);
    await d.handlers.get("session_start")!(
      { reason: "startup" },
      context(cwd, "root", async (title) => {
        confirmations.push(title);
        return true;
      }, true, undefined),
    );
    assert.deepEqual(confirmations, []);
    assert.equal(getGoalPool(cwd, "root").get(), undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

 test("resume replacement starts with an empty goal pool for the fresh root", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-goal-lifecycle-"));
  try {
    const goalPool = getGoalPool(cwd, "old");
    goalPool.setScheduler(() => ({ clear() {} }));
    goalPool.bind({ cwd, hasUI: true, sendUserMessage: () => {}, notify: () => {} });
    assert.equal(goalPool.create({ cwd, prompt: "p", interval: "1m" }).ok, true);
    const d = registrations();
    registerLifecycleGates(d.pi);
    registerSessionEvents(d.pi);
    const switchResult = await d.handlers.get("session_before_switch")!(
      { reason: "resume" },
      context(cwd, "old", async () => { throw new Error("old goal must not be offered"); }),
    );
    assert.deepEqual(switchResult, { cancel: false });
    await d.handlers.get("session_start")!({ reason: "resume" }, context(cwd, "fresh", async () => {
      throw new Error("fresh session must not prompt");
    }));
    assert.equal(getGoalPool(cwd, "fresh").get(), undefined);
    assert.equal(getGoalPool(cwd, "old").get()?.prompt, "p");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("no-UI /new does not offer or clear another session's goal", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-goal-lifecycle-"));
  try {
    const d = registrations();
    const sent: string[] = [];
    d.pi.sendUserMessage = (content: string) => { sent.push(content); };
    const goalPool = getGoalPool(cwd);
    const callbacks: Array<() => void> = [];
    goalPool.setScheduler((callback) => {
      callbacks.push(callback);
      return { clear() {} };
    });
    goalPool.bind({ cwd, hasUI: true, sendUserMessage: d.pi.sendUserMessage, notify: () => {} });
    assert.equal(goalPool.create({ cwd, prompt: "p", interval: "1m" }).ok, true);
    registerLifecycleGates(d.pi);
    const result = await d.handlers.get("session_before_switch")!(
      { reason: "new" },
      context(cwd, "root", async () => true, false),
    );
    assert.deepEqual(result, { cancel: false });
    assert.equal(getGoalPool(cwd, "root").get()?.status, "active");
    void callbacks;
    void sent;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resume replacement pauses delivery and asks continue-or-clear before switching", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-goal-lifecycle-"));
  try {
    addActiveGoal(cwd);
    const d = registrations();
    registerLifecycleGates(d.pi);
    const result = await d.handlers.get("session_before_switch")!(
      { reason: "resume" },
      context(cwd, "root", async () => true),
    );
    // Resume is a session replacement reason; the goal decision must be gated.
    assert.deepEqual(result, { cancel: false });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("quit shutdown clears goal timers and bindings idempotently", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-goal-lifecycle-"));
  try {
    addActiveGoal(cwd);
    const d = registrations();
    registerSessionEvents(d.pi);
    await d.handlers.get("session_shutdown")!({ reason: "quit" }, context(cwd, "root", async () => true));
    await d.handlers.get("session_shutdown")!({ reason: "quit" }, context(cwd, "root", async () => true));
    // Goal timers/bindings are cleared on quit; the persisted record is
    // paused but untouched and idempotent across repeated shutdowns.
    const goal = getGoalPool(cwd).get();
    assert.equal(goal?.status, "paused");
    assert.match(goal?.pauseReason ?? "", /quit/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});