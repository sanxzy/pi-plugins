import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { PERSISTENCE_OPERATIONS, createSessionLogger, runWithLogContext } from "@xzy-ai/observability";
import { createJob, updateJob, type Job, type JobUpdate } from "@xzy-ai/core";
import { canTransition } from "@xzy-ai/core";
import type { ChildRunResult } from "@xzy-ai/core";
import {
  backgroundModeError,
  formatBackgroundResult,
  runBackgroundJob,
  getChildPool,
} from "@xzy-ai/runtime";
import { createDeliveryCoordinator, encodeProjectId, homeSessionDir, pendingDeliveryFile } from "@xzy-ai/runtime";
import { createConcurrencyGate } from "@xzy-ai/runtime";
import { MAX_CONCURRENCY } from "@xzy-ai/core";
import { createAgentEventRegistry } from "@xzy-ai/runtime";

/**
 * Phase 5 background-delivery tests.
 *
 * Covers the delivery coordinator (direct-parent routing, deferred delivery
 * across session replacement, chain aggregation), `runBackgroundJob` (terminal
 * status + delivery for completed/failed/aborted children), and the queue
 * draining background jobs through the real concurrency gate. The registry is
 * faked in memory with the same transition rules so the tests stay pure.
 */

/** Drain the whole microtask chain (release → admit → waiter resume). */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** In-memory registry mirroring the real transition rules. */
function createFakeRegistry(): {
  jobs: Map<string, Job>;
  updateJob(jobId: string, update: JobUpdate): void;
} {
  const jobs = new Map<string, Job>();
  return {
    jobs,
    updateJob(jobId: string, update: JobUpdate): void {
      const job = jobs.get(jobId);
      if (!job) return;
      const to = update.status;
      if (to !== undefined && !canTransition(job.status, to)) return;
      jobs.set(jobId, updateJob(job, update));
    },
  };
}

function makeJob(jobId: string, status = "queued", description = "d"): Job {
  return createJob({ jobId, status: status as Job["status"], description, subagentType: "test-agent" });
}

function completedResult(output: string): ChildRunResult {
  return { sessionFile: "/sessions/1.jsonl", output, status: "completed" };
}

test("delivery load telemetry never persists pending result content", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-c2-delivery-secret-"));
  const pendingFile = pendingDeliveryFile(root, "root-a");
  const logDir = join(root, "logs");
  const logger = createSessionLogger({
    projectId: "project",
    rootSessionId: "root-a",
    eventsPath: join(logDir, "events.jsonl"),
    errorsPath: join(logDir, "errors.jsonl"),
  });
  try {
    mkdirSync(dirname(pendingFile), { recursive: true });
    writeFileSync(pendingFile, JSON.stringify([
      { jobId: "job-a", parentSessionFile: "parent-a.jsonl", content: "SUPER-SECRET-QUEUE-CONTENT" },
    ], null, 2));
    runWithLogContext(logger, () => {
      const coordinator = createDeliveryCoordinator({ projectRoot: root, rootSessionId: "root-a" });
      assert.equal(coordinator.pendingCount, 1);
    });
    const events = readFileSync(join(logDir, "events.jsonl"), "utf8");
    assert.ok(!events.includes("SUPER-SECRET-QUEUE-CONTENT"), "pending content must never appear in load telemetry");
    const records = events.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const loadRecords = records.filter((record) => record.operation === PERSISTENCE_OPERATIONS.DELIVERY_LOAD);
    assert.deepEqual(loadRecords.map((record) => record.phase), ["before", "after"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt pending delivery queue is tolerated without error records", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-c2-delivery-corrupt-"));
  const pendingFile = pendingDeliveryFile(root, "root-a");
  const logDir = join(root, "logs");
  const logger = createSessionLogger({
    projectId: "project",
    rootSessionId: "root-a",
    eventsPath: join(logDir, "events.jsonl"),
    errorsPath: join(logDir, "errors.jsonl"),
  });
  try {
    mkdirSync(dirname(pendingFile), { recursive: true });
    writeFileSync(pendingFile, "{not valid json");
    runWithLogContext(logger, () => {
      const coordinator = createDeliveryCoordinator({ projectRoot: root, rootSessionId: "root-a" });
      assert.equal(coordinator.pendingCount, 0);
    });
    const records = readFileSync(join(logDir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(records.filter((record) => record.phase === "error").length, 0);
    const loadRecords = records.filter((record) => record.operation === PERSISTENCE_OPERATIONS.DELIVERY_LOAD);
    assert.deepEqual(loadRecords.map((record) => record.phase), ["before", "after"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("delivery load and persist emit boundary records for the durable queue", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-c2-delivery-log-"));
  const logDir = join(root, "logs");
  const logger = createSessionLogger({
    projectId: "project",
    rootSessionId: "root-a",
    eventsPath: join(logDir, "events.jsonl"),
    errorsPath: join(logDir, "errors.jsonl"),
  });
  runWithLogContext(logger, () => {
    const coordinator = createDeliveryCoordinator({ projectRoot: root, rootSessionId: "root-a" });
    coordinator.deliverResult("job-a", "parent-a.jsonl", "result-a");
  });
  const records = readFileSync(join(logDir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const operation of [PERSISTENCE_OPERATIONS.DELIVERY_LOAD, PERSISTENCE_OPERATIONS.DELIVERY_PERSIST]) {
    assert.deepEqual(records.filter((record) => record.operation === operation && record.phase === "before").length, 1, `missing ${operation}`);
    assert.deepEqual(records.filter((record) => record.operation === operation && record.phase === "after").length, 1, `missing ${operation}`);
  }
  rmSync(root, { recursive: true, force: true });
});

test("pool delivery coordinator uses the centralized retry delay while explicit overrides win", async () => {
  const previousHome = process.env.PI_C2_TEST_HOME;
  const home = mkdtempSync(join(tmpdir(), "pi-c2-delivery-settings-home-"));
  const root = mkdtempSync(join(tmpdir(), "pi-c2-delivery-settings-project-"));
  process.env.PI_C2_TEST_HOME = home;
  mkdirSync(join(home, "pi-c2"), { recursive: true });
  writeFileSync(join(home, "pi-c2", "config.json"), JSON.stringify({ runtime: { deliveryRetryDelayMs: 40 } }));
  try {
    const pool = getChildPool(root, "phase4-root");
    const coordinator = pool.deliveryFor("phase4-root");
    const started = Date.now();
    let accept = false;
    coordinator.register("parent.jsonl", () => {
      if (!accept) throw new Error("busy");
    });
    coordinator.deliverResult("job", "parent.jsonl", "result");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(coordinator.pendingCount, 1, "configured retry has not fired after 10ms");
    accept = true;
    while (coordinator.pendingCount > 0 && Date.now() - started < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const elapsed = Date.now() - started;
    assert.equal(coordinator.pendingCount, 0, "configured retry eventually redrives delivery");
    assert.ok(elapsed < 2000, `retry should use the configured 40ms delay, not the default 2000ms (elapsed=${elapsed}ms)`);

    // The public constructor override remains an explicit test/effect seam.
    const overridden = createDeliveryCoordinator({ retryDelayMs: 7 });
    overridden.register("override-parent.jsonl", () => { throw new Error("busy"); });
    overridden.deliverResult("override-job", "override-parent.jsonl", "result");
    assert.equal(overridden.pendingCount, 1);
  } finally {
    if (previousHome === undefined) delete process.env.PI_C2_TEST_HOME;
    else process.env.PI_C2_TEST_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("delivery coordinator retries a rejected sink while its parent stays registered", async () => {
  // A registered sink that rejects (e.g. because the host agent is mid-run
  // during a reload) must self-heal: the result stays durable pending and the
  // coordinator re-drives delivery once the sink accepts, without requiring
  // the parent session to re-register.
  const coordinator = createDeliveryCoordinator({ retryDelayMs: 5 });
  const delivered: string[] = [];
  let reject = true;
  coordinator.register("parent-a.jsonl", (content) => {
    if (reject) throw new Error("host agent is busy");
    delivered.push(content);
  });

  const sent = coordinator.deliverResult("job-a", "parent-a.jsonl", "result-a");
  assert.equal(sent, false);
  assert.equal(coordinator.pendingCount, 1);
  assert.deepEqual(delivered, [], "the busy host must not receive the result yet");

  // The host run settles; the coordinator retries on its own and delivers.
  reject = false;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(coordinator.pendingCount, 0);
  assert.deepEqual(delivered, ["result-a"]);
});

test("delivery coordinator stops scheduling retries once the sink is unregistered", async () => {
  const coordinator = createDeliveryCoordinator({ retryDelayMs: 5 });
  const delivered: string[] = [];
  let reject = true;
  coordinator.register("parent-a.jsonl", (content) => {
    if (reject) throw new Error("host agent is busy");
    delivered.push(content);
  });
  coordinator.deliverResult("job-a", "parent-a.jsonl", "result-a");
  assert.equal(coordinator.pendingCount, 1);

  // The parent disappears before accepting; the result stays pending for a
  // later registration instead of being force-delivered.
  coordinator.unregister("parent-a.jsonl");
  reject = false;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(coordinator.pendingCount, 1);
  assert.deepEqual(delivered, []);
});

test("delivery coordinator routes a result to its own direct parent", () => {
  const coordinator = createDeliveryCoordinator();
  const delivered: string[] = [];
  coordinator.register("parent-a.jsonl", (content) => delivered.push(content));

  const sent = coordinator.deliverResult("job-a", "parent-a.jsonl", "result-a");
  assert.equal(sent, true);
  assert.deepEqual(delivered, ["result-a"]);
  assert.equal(coordinator.activeCount, 1);
  assert.equal(coordinator.pendingCount, 0);

  // A different parent never receives another parent's result.
  const other: string[] = [];
  coordinator.register("parent-b.jsonl", (content) => other.push(content));
  coordinator.deliverResult("job-b", "parent-b.jsonl", "result-b");
  assert.deepEqual(delivered, ["result-a"]);
  assert.deepEqual(other, ["result-b"]);
});

test("delivery coordinator defers results until the parent session re-registers", () => {
  const coordinator = createDeliveryCoordinator();
  const sent = coordinator.deliverResult("job-a", "parent-a.jsonl", "result-a");
  assert.equal(sent, false);
  assert.equal(coordinator.pendingCount, 1);

  const delivered: string[] = [];
  coordinator.register("parent-a.jsonl", (content) => delivered.push(content));
  assert.deepEqual(delivered, ["result-a"]);
  assert.equal(coordinator.pendingCount, 0);
});

test("deferred results survive a coordinator restart through the durable queue", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-c2-delivery-durable-"));
  const pendingFile = pendingDeliveryFile(root, "root-a");
  try {
    // First coordinator instance (e.g. a parent session that is unavailable).
    const first = createDeliveryCoordinator({ projectRoot: root, rootSessionId: "root-a" });
    const sent = first.deliverResult("job-a", "parent-a.jsonl", "result-a");
    assert.equal(sent, false);
    assert.equal(first.pendingCount, 1);
    assert.equal(existsSync(pendingFile), true);

    // Pending delivery is owned by the root session under home storage, not
    // project-local: its path sits under the session directory and the file is
    // owner-only, so one session's queue never leaks into the project scope.
    assert.ok(pendingFile.includes(homeSessionDir(encodeProjectId(root), "root-a")));
    assert.equal(statSync(pendingFile).mode & 0o777, 0o600);

    // A fresh coordinator (process restart / reload) replays the queued result.
    const second = createDeliveryCoordinator({ projectRoot: root, rootSessionId: "root-a" });
    assert.equal(second.pendingCount, 1);
    const delivered: string[] = [];
    second.register("parent-a.jsonl", (content) => delivered.push(content));
    assert.deepEqual(delivered, ["result-a"]);
    assert.equal(second.pendingCount, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("delivery register and unregister emit boundary records around actual sink mutations (H8)", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-c2-delivery-h8-"));
  const logDir = join(root, "logs");
  const logger = createSessionLogger({
    projectId: "project",
    rootSessionId: "root-a",
    eventsPath: join(logDir, "events.jsonl"),
    errorsPath: join(logDir, "errors.jsonl"),
  });
  try {
    runWithLogContext(logger, () => {
      const coordinator = createDeliveryCoordinator();
      const delivered: string[] = [];
      coordinator.register("parent-a.jsonl", (content) => delivered.push(content));
      coordinator.unregister("parent-a.jsonl");
    });
    const records = readFileSync(join(logDir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const operation of [PERSISTENCE_OPERATIONS.DELIVERY_REGISTER, PERSISTENCE_OPERATIONS.DELIVERY_UNREGISTER]) {
      const phases = records.filter((record) => record.operation === operation).map((record) => record.phase);
      assert.deepEqual(phases, ["before", "after"], `${operation} must wrap its mutation`);
    }
    assert.equal(records.filter((record) => record.phase === "error").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no-op unregister and rebind calls are silent (no boundary noise) (H8)", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-c2-delivery-h8-silent-"));
  const logDir = join(root, "logs");
  const logger = createSessionLogger({
    projectId: "project",
    rootSessionId: "root-a",
    eventsPath: join(logDir, "events.jsonl"),
    errorsPath: join(logDir, "errors.jsonl"),
  });
  try {
    runWithLogContext(logger, () => {
      const coordinator = createDeliveryCoordinator();
      coordinator.unregister("never-registered.jsonl");
      coordinator.rebind("same.jsonl", "same.jsonl");
      coordinator.rebind("nothing-pending.jsonl", "other.jsonl");
    });
    const raw = readFileSync(join(logDir, "events.jsonl"), "utf8");
    const records = raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(records.filter((record) => record.operation === PERSISTENCE_OPERATIONS.DELIVERY_UNREGISTER).length, 0, "unknown-sink unregister must not emit records");
    assert.equal(records.filter((record) => record.operation === PERSISTENCE_OPERATIONS.DELIVERY_REBIND).length, 0, "no-op rebind must not emit records");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rebind records a boundary and moves only matching pending results (H8)", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-c2-delivery-h8-rebind-"));
  const logDir = join(root, "logs");
  const logger = createSessionLogger({
    projectId: "project",
    rootSessionId: "root-a",
    eventsPath: join(logDir, "events.jsonl"),
    errorsPath: join(logDir, "errors.jsonl"),
  });
  try {
    runWithLogContext(logger, () => {
      const coordinator = createDeliveryCoordinator();
      coordinator.deliverResult("job-a", "old-parent.jsonl", "result-a");
      coordinator.deliverResult("job-b", "unrelated.jsonl", "result-b");
      coordinator.rebind("old-parent.jsonl", "new-parent.jsonl");
      const delivered: string[] = [];
      coordinator.register("new-parent.jsonl", (content) => delivered.push(content));
      assert.deepEqual(delivered, ["result-a"]);
      assert.equal(coordinator.pendingCount, 1);
    });
    const records = readFileSync(join(logDir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const rebindRecords = records.filter((record) => record.operation === PERSISTENCE_OPERATIONS.DELIVERY_REBIND);
    assert.deepEqual(rebindRecords.map((record) => record.phase), ["before", "after"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("delivery coordinator drops a stale sink on unregister", () => {
  const coordinator = createDeliveryCoordinator();
  coordinator.register("parent-a.jsonl", () => {});
  coordinator.unregister("parent-a.jsonl");
  assert.equal(coordinator.activeCount, 0);

  const sent = coordinator.deliverResult("job-a", "parent-a.jsonl", "result-a");
  assert.equal(sent, false);
  assert.equal(coordinator.pendingCount, 1);
});

test("two children deliver to their own parents and the chain aggregates upward", async () => {
  const coordinator = createDeliveryCoordinator();
  const rootDelivered: string[] = [];
  const childADelivered: string[] = [];
  const childBDelivered: string[] = [];

  // Root is the top-level parent session; child A and child B run beneath it.
  coordinator.register("root.jsonl", (content) => rootDelivered.push(content));
  coordinator.register("child-a.jsonl", (content) => childADelivered.push(content));
  coordinator.register("child-b.jsonl", (content) => childBDelivered.push(content));

  // Two grandchildren complete under different parents.
  coordinator.deliverResult("grand-a", "child-a.jsonl", "result-a");
  coordinator.deliverResult("grand-b", "child-b.jsonl", "result-b");
  // Each child aggregates its own result upward to the root.
  coordinator.deliverResult("child-a", "root.jsonl", "aggregated-a");
  coordinator.deliverResult("child-b", "root.jsonl", "aggregated-b");

  assert.deepEqual(childADelivered, ["result-a"]);
  assert.deepEqual(childBDelivered, ["result-b"]);
  assert.deepEqual(rootDelivered, ["aggregated-a", "aggregated-b"]);
});

test("runBackgroundJob completes a child and marks it delivered", async () => {
  const registry = createFakeRegistry();
  const job = makeJob("bg-1", "queued");
  registry.jobs.set(job.jobId, job);

  const coordinator = createDeliveryCoordinator();
  const delivered: string[] = [];
  coordinator.register("parent.jsonl", (content) => delivered.push(content));

  await runBackgroundJob(
    { registry, delivery: coordinator },
    job,
    {
      parentSessionFile: "parent.jsonl",
      runChild: async () => {
        // The composition root marks `running` at slot admission before the
        // child runs; mirror it here so the terminal transition is legal.
        registry.updateJob(job.jobId, { status: "running" });
        return completedResult("the output");
      },
    },
  );

  assert.equal(registry.jobs.get("bg-1")?.status, "completed");
  assert.equal(registry.jobs.get("bg-1")?.sessionFile, "/sessions/1.jsonl");
  assert.equal(registry.jobs.get("bg-1")?.delivered, true);
  assert.deepEqual(delivered, ['Background agent test-agent (bg-1) completed:\nthe output']);
});

test("runBackgroundJob marks a failed child failed and delivers the failure", async () => {
  const registry = createFakeRegistry();
  const job = makeJob("bg-2", "queued");
  registry.jobs.set(job.jobId, job);

  const coordinator = createDeliveryCoordinator();
  const delivered: string[] = [];
  coordinator.register("parent.jsonl", (content) => delivered.push(content));

  await runBackgroundJob(
    { registry, delivery: coordinator },
    job,
    {
      parentSessionFile: "parent.jsonl",
      runChild: async () => {
        registry.updateJob(job.jobId, { status: "running" });
        return { sessionFile: "", output: "boom", status: "failed" };
      },
    },
  );

  assert.equal(registry.jobs.get("bg-2")?.status, "failed");
  assert.equal(registry.jobs.get("bg-2")?.delivered, true);
  assert.deepEqual(delivered, ['Background agent test-agent (bg-2) failed: boom']);
});

test("runBackgroundJob marks an aborted child cancelled", async () => {
  const registry = createFakeRegistry();
  const job = makeJob("bg-3", "queued");
  registry.jobs.set(job.jobId, job);
  const coordinator = createDeliveryCoordinator();
  coordinator.register("parent.jsonl", () => {});

  await runBackgroundJob(
    { registry, delivery: coordinator },
    job,
    {
      parentSessionFile: "parent.jsonl",
      runChild: async () => {
        registry.updateJob(job.jobId, { status: "running" });
        return { sessionFile: "", output: "(aborted)", status: "aborted" };
      },
    },
  );

  assert.equal(registry.jobs.get("bg-3")?.status, "cancelled");
  assert.equal(registry.jobs.get("bg-3")?.delivered, true);
});

test("runBackgroundJob catches an unexpected throw and marks the job failed", async () => {
  const registry = createFakeRegistry();
  const job = makeJob("bg-4", "queued");
  registry.jobs.set(job.jobId, job);
  const coordinator = createDeliveryCoordinator();
  const delivered: string[] = [];
  coordinator.register("parent.jsonl", (content) => delivered.push(content));

  await runBackgroundJob(
    { registry, delivery: coordinator },
    job,
    {
      parentSessionFile: "parent.jsonl",
      runChild: async () => {
        registry.updateJob(job.jobId, { status: "running" });
        throw new Error("unexpected");
      }
    },
  );

  assert.equal(registry.jobs.get("bg-4")?.status, "failed");
  assert.equal(registry.jobs.get("bg-4")?.delivered, true);
  assert.deepEqual(delivered, ['Background agent test-agent (bg-4) failed: unexpected']);
});

test("runBackgroundJob persists a real agent lifecycle in the event read model", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-c2-phase5-agent-home-"));
  process.env.PI_C2_TEST_HOME = home;
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-c2-phase5-agent-project-"));
  const eventRegistry = createAgentEventRegistry(projectRoot, "root-session");
  const job = makeJob("job-live", "queued");
  eventRegistry.createJob(job);
  const registry = createFakeRegistry();
  registry.jobs.set(job.jobId, job);
  const coordinator = createDeliveryCoordinator();
  coordinator.register("parent.jsonl", () => {});

  await runBackgroundJob(
    { registry: eventRegistry, delivery: coordinator },
    job,
    {
      parentSessionFile: "parent.jsonl",
      runChild: async () => {
        eventRegistry.updateJob(job.jobId, { status: "running" });
        return { sessionFile: "transcript.jsonl", output: "done", status: "completed" };
      },
    },
  );

  const folded = eventRegistry.get("job-live");
  assert.ok(folded);
  assert.equal(folded.jobId, "live");
  assert.equal(folded.status, "completed");
  assert.equal(folded.delivered, true);
  assert.equal(folded.sessionFile, "transcript.jsonl");
  const persisted = eventRegistry.get("live");
  assert.equal(persisted?.status, "completed");
  const eventsPath = eventRegistry.fileForJob("live");
  assert.ok(eventsPath);
  assert.equal(statSync(eventsPath).mode & 0o777, 0o600);
  assert.equal(statSync(eventsPath.replace("events.jsonl", "agent.json")).mode & 0o777, 0o600);
});

test("a background job beyond the cap is queued and starts when a slot frees", async () => {
  const gate = createConcurrencyGate(MAX_CONCURRENCY);
  const registry = createFakeRegistry();
  const coordinator = createDeliveryCoordinator();
  coordinator.register("parent.jsonl", () => {});

  // Hold all slots with foreground-style operations.
  const holds = Array.from({ length: MAX_CONCURRENCY }, () => deferred<void>());
  const holdRuns = holds.map((hold) =>
    gate.run(async () => {
      await hold.promise;
    }),
  );

  // The background job must wait for a slot.
  const job = makeJob("bg-queue", "queued");
  registry.jobs.set(job.jobId, job);
  const run = runBackgroundJob(
    { registry, delivery: coordinator },
    job,
    {
      parentSessionFile: "parent.jsonl",
      runChild: () =>
        gate.run(async () => {
          registry.updateJob(job.jobId, { status: "running" });
          return completedResult("ran");
        }),
    },
  );

  await flush();
  assert.equal(gate.activeCount, MAX_CONCURRENCY);
  assert.equal(gate.queuedCount, 1);
  assert.equal(registry.jobs.get("bg-queue")?.status, "queued");

  // Free one slot; the queued background job is admitted next.
  holds[0].resolve();
  await Promise.race([run, flush()]);
  await flush();
  assert.equal(registry.jobs.get("bg-queue")?.status, "completed");

  // Release the remaining holders so the test can finish.
  for (let i = 1; i < holds.length; i += 1) {
    holds[i].resolve();
  }
  await Promise.all([...holdRuns, run]);
  assert.equal(gate.activeCount, 0);
  assert.equal(gate.queuedCount, 0);
});

test("backgroundModeError rejects non-TUI root modes and allows the TUI", () => {
  assert.equal(backgroundModeError("tui"), undefined);
  assert.equal(backgroundModeError("print"), "background mode is invalid in print mode");
  assert.equal(backgroundModeError("json"), "background mode is invalid in json mode");
  assert.equal(backgroundModeError("rpc"), "background mode is invalid in rpc mode");
});

test("backgroundModeError no longer encodes a nested-child bypass (children run foreground)", () => {
  // Child and descendant calls never use the background path, so the nested
  // bypass flag is removed entirely; every non-TUI root background request is
  // rejected.
  assert.equal(backgroundModeError("print"), "background mode is invalid in print mode");
  assert.equal(backgroundModeError("json"), "background mode is invalid in json mode");
});

test("formatBackgroundResult formats each terminal child status", () => {
  assert.equal(formatBackgroundResult("reviewer", "j1", completedResult("done")), 'Background agent reviewer (j1) completed:\ndone');
  assert.equal(
    formatBackgroundResult("reviewer", "j1", { sessionFile: "", output: "", status: "aborted" }),
    'Background agent reviewer (j1) was aborted.',
  );
  assert.equal(
    formatBackgroundResult("reviewer", "j1", { sessionFile: "", output: "nope", status: "failed" }),
    'Background agent reviewer (j1) failed: nope',
  );
});