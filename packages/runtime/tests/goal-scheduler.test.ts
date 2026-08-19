import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GOAL_DELIVERY_FOOTER } from "@xzy-ai/core";
import { GOAL_OPERATIONS, createSessionLogger, runWithLogContext } from "@xzy-ai/observability";
import { createGoalPool, getGoalPool, type GoalDeliveryBinding } from "@xzy-ai/runtime";

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-c2-goal-scheduler-"));
}

function binding(overrides: Partial<GoalDeliveryBinding> = {}): GoalDeliveryBinding {
  const base: GoalDeliveryBinding = {
    cwd: "/project",
    sendUserMessage: () => {},
    hasUI: true,
    notify: (_message: string) => {},
    hasPendingMessages: () => false,
  };
  return { ...base, ...overrides };
}

test("goal tick telemetry binds to the pool's own logger, not the stale default (H3)", () => {
  const pool = createGoalPool(projectRoot());
  pool.setScheduler(() => ({ clear() {} }));
  const lines: Array<Record<string, unknown>> = [];
  const own = createSessionLogger({ projectId: "project-own", rootSessionId: "root-own", eventsPath: "/dev/stdout", errorsPath: "/dev/stdout", write: (_p, line) => lines.push(JSON.parse(line)) });
  // A newer logger from an unrelated session becomes the global default; the
  // pool must ignore it for its own independent tick root.
  createSessionLogger({ projectId: "project-other", rootSessionId: "root-other", eventsPath: "/dev/stdout", errorsPath: "/dev/stdout", write: () => undefined });
  pool.bind({ cwd: "/project", sendUserMessage: () => {}, hasUI: true, notify: () => {}, hasPendingMessages: () => false, logger: own });
  assert.equal(pool.create({ cwd: "/project", prompt: "p", interval: "1m" }).ok, true);
  pool.tick("/project");
  const tickRecords = lines.filter((record) => record.operation === GOAL_OPERATIONS.TICK);
  assert.ok(tickRecords.length >= 1, "tick records must use the pool's own logger");
  for (const record of tickRecords) {
    assert.equal(record.projectId, "project-own");
    assert.equal(record.rootSessionId, "root-own");
  }
});

test("first active delivery occurs immediately on goal creation", () => {
  const pool = createGoalPool(projectRoot());
  const sent: Array<{ content: string; deliverAs: string }> = [];
  pool.setScheduler(() => ({ clear() {} }));
  pool.bind(binding({
    sendUserMessage: (content, options) => sent.push({ content, deliverAs: options?.deliverAs ?? "" }),
  }));
  const created = pool.create({ cwd: "/project", prompt: "exact prompt", interval: "10s" });
  assert.equal(created.ok, true);
  assert.equal(sent.length, 1, "goal is delivered immediately on creation");
  assert.equal(sent[0]?.deliverAs, "steer");
});

test("active ticks deliver exact prompt plus footer with steer even while busy", () => {
  const pool = createGoalPool(projectRoot());
  const sent: string[] = [];
  const notifications: string[] = [];
  pool.setScheduler(() => ({ clear() {} }));
  pool.bind(binding({ sendUserMessage: (content) => sent.push(content), notify: (message) => notifications.push(message) }));
  assert.equal(pool.create({ cwd: "/project", prompt: "p", interval: "1m" }).ok, true);
  // create() triggers an immediate delivery
  pool.tick("/project");
  pool.tick("/project");
  assert.deepEqual(sent, [`p\n${GOAL_DELIVERY_FOOTER}`, `p\n${GOAL_DELIVERY_FOOTER}`, `p\n${GOAL_DELIVERY_FOOTER}`]);
  assert.deepEqual(notifications, ["Goal triggered and sent to the current session — this goal will be sent every 1m.", "Goal triggered and sent to the current session — this goal will be sent every 1m.", "Goal triggered and sent to the current session — this goal will be sent every 1m."]);
});

test("paused ticks warn through UI only and no-UI ticks do nothing", () => {
  const pool = createGoalPool(projectRoot());
  const sent: string[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  pool.setScheduler(() => ({ clear() {} }));
  pool.bind(binding({
    sendUserMessage: (content) => sent.push(content),
    notify: (message, type) => {
      if (type === "warning") warnings.push(`${type}:${message}`);
      if (type === "info") infos.push(`${type}:${message}`);
    },
  }));
  assert.equal(pool.create({ cwd: "/project", prompt: "p", interval: "1m" }).ok, true);
  // create() triggers an immediate delivery
  assert.deepEqual(sent, [`p\n${GOAL_DELIVERY_FOOTER}`]);
  assert.equal(pool.pause("waiting").ok, true);
  pool.tick("/project");
  assert.deepEqual(sent, [`p\n${GOAL_DELIVERY_FOOTER}`]);
  assert.deepEqual(warnings, ["warning:Goal paused: waiting"]);

  pool.bind(binding({ hasUI: false, notify: (message, type) => {
    if (type === "warning") warnings.push(`${type}:${message}`);
    if (type === "info") infos.push(`${type}:${message}`);
  } }));
  pool.tick("/project");
  assert.deepEqual(sent, [`p\n${GOAL_DELIVERY_FOOTER}`]);
  assert.deepEqual(warnings, ["warning:Goal paused: waiting"]);
});

test("scheduler rereads persisted state and isolates cwd delivery failures", () => {
  const root = projectRoot();
  const poolA = createGoalPool(root, "root-a");
  const poolB = createGoalPool(root, "root-b");
  const delivered: string[] = [];
  const failed: string[] = [];
  poolA.setScheduler(() => ({ clear() {} }));
  poolB.setScheduler(() => ({ clear() {} }));
  poolA.bind(binding({
    cwd: join(root, "a"),
    sendUserMessage: (content) => {
      failed.push(content);
      throw new Error("failed A");
    },
    notify: () => {},
  }));
  poolB.bind(binding({ cwd: join(root, "b"), sendUserMessage: (content) => delivered.push(content), notify: () => {} }));
  assert.equal(poolA.create({ cwd: join(root, "a"), prompt: "A", interval: "1m" }).ok, true);
  // create() triggers an immediate delivery that throws
  assert.equal(failed.length, 1);
  assert.equal(poolB.create({ cwd: join(root, "b"), prompt: "B", interval: "1m" }).ok, true);
  // create() triggers an immediate delivery
  assert.deepEqual(delivered, [`B\n${GOAL_DELIVERY_FOOTER}`]);
  poolA.tick(join(root, "a"));
  poolB.tick(join(root, "b"));
  assert.equal(failed.length, 2, "immediate tick + manual tick both deliver despite the throw");
  assert.deepEqual(delivered, [`B\n${GOAL_DELIVERY_FOOTER}`, `B\n${GOAL_DELIVERY_FOOTER}`]);

  poolB.pause("paused");
  poolB.tick(join(root, "b"));
  assert.deepEqual(delivered, [`B\n${GOAL_DELIVERY_FOOTER}`, `B\n${GOAL_DELIVERY_FOOTER}`]);
  assert.deepEqual(failed, [
    "A\n" + GOAL_DELIVERY_FOOTER,
    "A\n" + GOAL_DELIVERY_FOOTER,
  ]);
});

test("an unbound cwd or a cleared goal stops delivery", () => {
  const pool = createGoalPool(projectRoot());
  const sent: string[] = [];
  pool.setScheduler(() => ({ clear() {} }));
  pool.bind(binding({ cwd: "/other", sendUserMessage: (content) => sent.push(content) }));
  assert.equal(pool.create({ cwd: "/project", prompt: "p", interval: "1m" }).ok, true);
  // create() triggers an immediate delivery
  assert.equal(sent.length, 1);
  pool.tick("/project");
  // No binding for /project: the current-host fallback is the only binding, which
  // is /other — delivery still routes to the current host.
  assert.equal(sent.length, 2);
  pool.clear();
  pool.tick("/project");
  assert.equal(sent.length, 2, "cleared goal stops delivery");
});

test("shutdown clears timers and bindings idempotently", () => {
  const pool = getGoalPool(projectRoot());
  let clearCount = 0;
  pool.setScheduler(() => ({ clear: () => { clearCount += 1; } }));
  pool.bind(binding({ sendUserMessage: () => {} }));
  assert.equal(pool.create({ cwd: "/project", prompt: "p", interval: "1m" }).ok, true);
  pool.shutdown();
  pool.shutdown();
  assert.equal(clearCount, 1);
});

test("session confirmation pauses delivery and continuation waits for a fresh interval", () => {
  const pool = createGoalPool(projectRoot());
  const sent = { values: [] as string[] };
  const callbacks: Array<() => void> = [];
  let clearCount = 0;
  pool.setScheduler((callback) => {
    callbacks.push(callback);
    return { clear: () => { clearCount += 1; } };
  });
  pool.bind(binding({ sendUserMessage: (content) => sent.values.push(content) }));
  assert.equal(pool.create({ cwd: "/project", prompt: "p", interval: "1m" }).ok, true);
  // create() triggers an immediate delivery before session confirmation
  assert.deepEqual(sent.values, [`p\n${GOAL_DELIVERY_FOOTER}`]);
  assert.equal(callbacks.length, 1);

  assert.equal(pool.beginSessionConfirmation(), true);
  assert.equal(clearCount, 1);
  callbacks[0]!();
  assert.deepEqual(sent.values, [`p\n${GOAL_DELIVERY_FOOTER}`], "suspended delivery blocks post-confirmation ticks");

  pool.shutdown();
  const send = (content: string): void => { sent.values.push(content); };
  pool.bind({
    cwd: "/project",
    sendUserMessage: send,
    hasUI: true,
    notify: () => {},
    hasPendingMessages: () => false,
  });
  pool.resumeDelivery();
  assert.deepEqual(sent.values, [`p\n${GOAL_DELIVERY_FOOTER}`], "resume does not replay prior ticks");
  assert.equal(callbacks.length, 2);
  callbacks[0]!();
  assert.deepEqual(sent.values, [`p\n${GOAL_DELIVERY_FOOTER}`]);
  callbacks[1]!();
  assert.deepEqual(sent.values, [`p\n${GOAL_DELIVERY_FOOTER}`, `p\n${GOAL_DELIVERY_FOOTER}`]);
});

test("clearing confirmed active goals removes them and prevents stale callbacks", () => {
  const pool = createGoalPool(projectRoot());
  const sent: string[] = [];
  const callbacks: Array<() => void> = [];
  pool.setScheduler((callback) => {
    callbacks.push(callback);
    return { clear() {} };
  });
  pool.bind(binding({ sendUserMessage: (content) => sent.push(content) }));
  assert.equal(pool.create({ cwd: "/project", prompt: "p", interval: "1m" }).ok, true);
  // create() triggers an immediate delivery before session confirmation
  assert.deepEqual(sent, [`p\n${GOAL_DELIVERY_FOOTER}`]);
  assert.equal(pool.beginSessionConfirmation(), true);
  assert.equal(pool.clearActiveGoals(), 1);
  assert.equal(pool.get(), undefined);
  callbacks[0]!();
  assert.deepEqual(sent, [`p\n${GOAL_DELIVERY_FOOTER}`], "cleared goal prevents further delivery");
});

test("pauseAllActive pauses persisted goals without removing them and stops delivery", () => {
  const root = projectRoot();
  const pool = createGoalPool(root);
  const sent: string[] = [];
  const callbacks: Array<() => void> = [];
  let clearCount = 0;
  pool.setScheduler((callback) => {
    callbacks.push(callback);
    return { clear: () => { clearCount += 1; } };
  });
  pool.bind(binding({ sendUserMessage: (content) => sent.push(content) }));
  assert.equal(pool.create({ cwd: "/project", prompt: "p", interval: "1m" }).ok, true);
  // create() triggers an immediate delivery
  assert.deepEqual(sent, [`p\n${GOAL_DELIVERY_FOOTER}`]);
  assert.equal(callbacks.length, 1);

  assert.equal(pool.pauseAllActive("session exited (quit)"), 1);
  // Delivery is suspended and the scheduler is stopped.
  callbacks[0]!();
  assert.deepEqual(sent, [`p\n${GOAL_DELIVERY_FOOTER}`], "paused delivery prevents further delivery");
  assert.equal(clearCount, 1);

  // The persisted record survives as paused and is restored on a fresh reader.
  const fresh = getGoalPool(root);
  const restored = fresh.get();
  assert.equal(restored?.prompt, "p");
  assert.equal(restored?.status, "paused");
  assert.equal(restored?.pauseReason, "session exited (quit)");
});
test("goal mutations emit correlated processWithLog records under a log context", () => {
  const pool = createGoalPool(projectRoot());
  pool.setScheduler(() => ({ clear() {} }));
  const lines: Array<Record<string, unknown>> = [];
  const active = createSessionLogger({
    projectId: "project-a",
    rootSessionId: "root-a",
    eventsPath: "/dev/stdout",
    errorsPath: "/dev/stdout",
    write: (_path, line) => lines.push(JSON.parse(line)),
  });
  const created = runWithLogContext(active, () => pool.create({ cwd: "/project", prompt: "p", interval: "1m" }));
  assert.equal(created.ok, true);
  const before = lines.filter((l) => l.operation === GOAL_OPERATIONS.CREATE && l.phase === "before");
  const after = lines.filter((l) => l.operation === GOAL_OPERATIONS.CREATE && l.phase === "after");
  assert.ok(before.length >= 1);
  assert.ok(after.length >= 1);
  assert.equal(before[0].correlationId, after[0].correlationId);
});
