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

function addActiveGoal(cwd: string, prompt = "p"): void {
  const pool = getGoalPool(cwd);
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
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-goal-lifecycle-"));
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

test("/new with a persisted active goal asks continue-or-clear and clears on Decline", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-goal-lifecycle-"));
  try {
    addActiveGoal(cwd);
    const d = registrations();
    registerLifecycleGates(d.pi);
    const result = await d.handlers.get("session_before_switch")!(
      { reason: "new" },
      context(cwd, "root", async () => false),
    );
    assert.deepEqual(result, { cancel: false });
    assert.equal(getGoalPool(cwd).get(cwd), undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session shutdown preserves the persisted goal while stopping delivery", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-goal-lifecycle-"));
  try {
    addActiveGoal(cwd);
    const d = registrations();
    registerSessionEvents(d.pi);
    await d.handlers.get("session_shutdown")!({ reason: "new" }, context(cwd, "root", async () => true));
    // Shutdown stops timers/bindings but never clears the persisted goal; the
    // fresh session decides Continue or Clear.
    assert.equal(getGoalPool(cwd).get(cwd)?.status, "active");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("startup with a persisted active goal awaits confirmation and continues on Continue", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-goal-lifecycle-"));
  try {
    addActiveGoal(cwd);
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
    assert.equal(confirmed.length, 1);
    // Continue preserves the goal and never delivers immediately.
    assert.equal(getGoalPool(cwd).get(cwd)?.status, "active");
    assert.equal(sent, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("startup confirmation clears the goal on Decline", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-goal-lifecycle-"));
  try {
    addActiveGoal(cwd);
    const d = registrations();
    registerSessionEvents(d.pi);
    await d.handlers.get("session_start")!(
      { reason: "startup" },
      context(cwd, "root", async () => false),
    );
    assert.equal(getGoalPool(cwd).get(cwd), undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("startup confirmation still runs when the host has no session file", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-goal-lifecycle-"));
  try {
    addActiveGoal(cwd);
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
    assert.deepEqual(confirmations, ["Persisted goal"]);
    assert.equal(getGoalPool(cwd).get(cwd)?.status, "active");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

 test("replacement Continue rebinds the fresh host and waits for one new interval", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-goal-lifecycle-"));
  try {
    const goalPool = getGoalPool(cwd);
    const oldSent: string[] = [];
    const freshSent: string[] = [];
    const callbacks: Array<() => void> = [];
    goalPool.setScheduler((callback) => {
      callbacks.push(callback);
      return { clear() {} };
    });
    goalPool.bind({
      cwd,
      hasUI: true,
      sendUserMessage: (content) => oldSent.push(content),
      notify: () => {},
    });
    assert.equal(goalPool.create({ cwd, prompt: "p", interval: "1m" }).ok, true);

    const d = registrations();
    registerLifecycleGates(d.pi);
    registerSessionEvents(d.pi);
    const switchResult = await d.handlers.get("session_before_switch")!(
      { reason: "resume" },
      context(cwd, "old", async () => true),
    );
    assert.deepEqual(switchResult, { cancel: false });
    assert.equal(callbacks.length, 1);

    await d.handlers.get("session_shutdown")!(
      { reason: "resume" },
      context(cwd, "old", async () => true),
    );
    d.pi.sendUserMessage = (content: string) => { freshSent.push(content); };
    await d.handlers.get("session_start")!(
      { reason: "resume" },
      context(cwd, "fresh", async () => {
        throw new Error("replacement Continue must not prompt twice");
      }),
    );

    assert.equal(callbacks.length, 2);
    callbacks[0]!();
    assert.deepEqual(oldSent, []);
    assert.deepEqual(freshSent, []);
    callbacks[1]!();
    assert.equal(oldSent.length, 0);
    assert.equal(freshSent.length, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("no-UI /new replacement cancels without clearing the goal and resumes current delivery", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-goal-lifecycle-"));
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
    // No-UI follows the existing cancellation boundary: cancel the switch and
    // preserve the goal rather than silently clearing it. Since this host stays
    // active, delivery must be rolled back rather than left suspended.
    assert.deepEqual(result, { cancel: true });
    assert.equal(getGoalPool(cwd).get(cwd)?.status, "active");
    callbacks[callbacks.length - 1]!();
    assert.equal(sent.length, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resume replacement pauses delivery and asks continue-or-clear before switching", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-goal-lifecycle-"));
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
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-goal-lifecycle-"));
  try {
    addActiveGoal(cwd);
    const d = registrations();
    registerSessionEvents(d.pi);
    await d.handlers.get("session_shutdown")!({ reason: "quit" }, context(cwd, "root", async () => true));
    await d.handlers.get("session_shutdown")!({ reason: "quit" }, context(cwd, "root", async () => true));
    // Goal timers/bindings are cleared on quit; the persisted record is untouched.
    assert.equal(getGoalPool(cwd).get(cwd)?.status, "active");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});