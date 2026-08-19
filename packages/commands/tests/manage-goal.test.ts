import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createJob } from "@xzy-ai/core";
import { getChildPool, getGoalPool, startRootSession } from "@xzy-ai/runtime";
import { registerManageGoal } from "../src/registrations/manage-goal-command.ts";
import { createManageGoalController } from "../src/registrations/manage-goal.ts";

test("controller get returns undefined with no goal and the record with one", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-manage-goal-"));
  try {
    const controller = createManageGoalController({ cwd, sessionId: "root" });
    assert.equal(await controller.get(), undefined);
    const pool = getGoalPool(cwd, "root");
    pool.setScheduler(() => ({ clear() {} }));
    pool.bind({ cwd, hasUI: true, sendUserMessage: () => {}, notify: () => {}, hasPendingMessages: () => false });
    assert.equal(pool.create({ cwd, prompt: "ship it", interval: "2h" }).ok, true);
    const goal = await controller.get();
    assert.equal(goal?.prompt, "ship it");
    assert.equal(goal?.status, "active");
    assert.equal(goal?.intervalMs, 7_200_000);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("controller create replaces an existing goal", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-manage-goal-"));
  try {
    const controller = createManageGoalController({ cwd, sessionId: "root" });
    const pool = getGoalPool(cwd, "root");
    pool.setScheduler(() => ({ clear() {} }));
    pool.bind({ cwd, hasUI: true, sendUserMessage: () => {}, notify: () => {}, hasPendingMessages: () => false });
    assert.equal(pool.create({ cwd, prompt: "first", interval: "1m" }).ok, true);

    const result = await controller.create({ prompt: "second", interval: "2h" });
    assert.deepEqual(result, { ok: true, message: "Goal created." });
    const goal = pool.get();
    assert.equal(goal?.prompt, "second");
    assert.equal(goal?.intervalMs, 7_200_000);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("controller create without interval uses the default 10m", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-manage-goal-"));
  try {
    const controller = createManageGoalController({ cwd, sessionId: "root" });
    const result = await controller.create({ prompt: "ship it", interval: "" });
    assert.equal(result.ok, true);
    assert.equal(getGoalPool(cwd, "root").get()?.intervalMs, 600_000);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("controller pause, resume, and clear round-trip the pool state", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-manage-goal-"));
  try {
    const controller = createManageGoalController({ cwd, sessionId: "root" });
    const pool = getGoalPool(cwd, "root");
    pool.setScheduler(() => ({ clear() {} }));
    pool.bind({ cwd, hasUI: true, sendUserMessage: () => {}, notify: () => {}, hasPendingMessages: () => false });
    assert.equal(pool.create({ cwd, prompt: "p", interval: "1m" }).ok, true);

    assert.deepEqual(await controller.pause("blocked"), { ok: true, message: "Goal paused." });
    assert.equal(pool.get()?.status, "paused");
    assert.equal(pool.get()?.pauseReason, "blocked");

    assert.deepEqual(await controller.resume(), { ok: true, message: "Goal resumed." });
    assert.equal(pool.get()?.status, "active");

    assert.deepEqual(await controller.clear(), { ok: true, message: "Goal cleared." });
    assert.equal(pool.get(), undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("controller reports failures for missing goals and empty pause reasons", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-manage-goal-"));
  try {
    const controller = createManageGoalController({ cwd, sessionId: "root" });
    assert.equal((await controller.pause("  ")).ok, false);
    assert.equal((await controller.resume()).ok, false);
    assert.equal((await controller.clear()).ok, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("controller is unavailable in child sessions", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-manage-goal-"));
  try {
    startRootSession({ projectRoot: cwd, sessionId: "root" });
    const pool = getGoalPool(cwd, "root");
    pool.setScheduler(() => ({ clear() {} }));
    pool.bind({ cwd, hasUI: true, sendUserMessage: () => {}, notify: () => {}, hasPendingMessages: () => false });
    assert.equal(pool.create({ cwd, prompt: "p", interval: "1m" }).ok, true);
    const childPool = getChildPool(cwd, "root");
    childPool.registry.createJob(createJob({
      jobId: "child-session",
      parentSessionId: "root",
      rootJobId: "child-session",
      depth: 0,
      status: "running",
      description: "child",
      subagentType: "test-agent",
      sessionId: "child-session",
    }));

    const controller = createManageGoalController({ cwd, sessionId: "child-session" });
    assert.equal(await controller.get(), undefined);
    assert.deepEqual(await controller.create({ prompt: "x", interval: "1m" }), { ok: false, message: "goal management is unavailable in child sessions" });
    assert.deepEqual(await controller.pause("r"), { ok: false, message: "goal management is unavailable in child sessions" });
    assert.deepEqual(await controller.resume(), { ok: false, message: "goal management is unavailable in child sessions" });
    assert.deepEqual(await controller.clear(), { ok: false, message: "goal management is unavailable in child sessions" });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("/c2-manage-goal is registered and maps wizard results to notifications", async () => {
  const handlers = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const notifications: Array<[string, string]> = [];
  const pi = {
    registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
      handlers.set(name, options.handler);
    },
  } as unknown as ExtensionAPI;
  registerManageGoal(pi);
  assert.equal(handlers.has("c2-manage-goal"), true);
  const ctxFor = (result: unknown): ExtensionCommandContext => ({
    mode: "tui",
    hasUI: true,
    signal: undefined,
    cwd: "/tmp",
    sessionManager: { getSessionId: () => "root" },
    ui: {
      custom: async () => result,
      notify: (message: string, kind?: string) => notifications.push([message, kind ?? "info"] as [string, string]),
    },
  } as unknown as ExtensionCommandContext);
  await handlers.get("c2-manage-goal")!("", ctxFor({ status: "saved", message: "Goal created." }));
  await handlers.get("c2-manage-goal")!("", ctxFor({ status: "error", message: "Broken" }));
  await handlers.get("c2-manage-goal")!("", ctxFor({ status: "cancelled" }));
  assert.deepEqual(notifications, [
    ["Goal created.", "info"],
    ["Broken", "error"],
    ["Goal management cancelled", "info"],
  ]);
});

test("/c2-manage-goal is gated to interactive TUI", async () => {
  const handlers = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const notifications: string[] = [];
  const pi = {
    registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
      handlers.set(name, options.handler);
    },
  } as unknown as ExtensionAPI;
  registerManageGoal(pi);
  await handlers.get("c2-manage-goal")!("", {
    mode: "rpc",
    hasUI: true,
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionCommandContext);
  assert.match(notifications[0]!, /requires an interactive TUI/);
});
