import assert from "node:assert/strict";
import { test } from "node:test";
import { createJob, updateJob, type Job, type JobUpdate } from "../src/domain/jobs/job.ts";
import { canTransition } from "../src/domain/jobs/status.ts";
import type { ChildRunResult } from "../src/domain/ports/child-session.ts";
import {
  backgroundModeError,
  formatBackgroundResult,
  runBackgroundJob,
} from "../src/infrastructure/pool/background.ts";
import { createDeliveryCoordinator } from "../src/infrastructure/pool/delivery.ts";
import { createConcurrencyGate } from "../src/infrastructure/pool/concurrency-gate.ts";
import { MAX_CONCURRENCY } from "../src/shared/constants.ts";

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
  return createJob({ jobId, status: status as Job["status"], description, subagentType: "default" });
}

function completedResult(output: string): ChildRunResult {
  return { sessionFile: "/sessions/1.jsonl", output, status: "completed" };
}

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
  assert.deepEqual(delivered, ["Background task bg-1 completed:\nthe output"]);
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
  assert.deepEqual(delivered, ["Background task bg-2 failed: boom"]);
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
  assert.deepEqual(delivered, ["Background task bg-4 failed: unexpected"]);
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

test("backgroundModeError rejects non-TUI modes and allows the TUI", () => {
  assert.equal(backgroundModeError("tui"), undefined);
  assert.equal(backgroundModeError("print"), "background mode is invalid in print mode");
  assert.equal(backgroundModeError("json"), "background mode is invalid in json mode");
  assert.equal(backgroundModeError("rpc"), "background mode is invalid in rpc mode");
});

test("formatBackgroundResult formats each terminal child status", () => {
  assert.equal(formatBackgroundResult("j1", completedResult("done")), "Background task j1 completed:\ndone");
  assert.equal(
    formatBackgroundResult("j1", { sessionFile: "", output: "", status: "aborted" }),
    "Background task j1 was aborted.",
  );
  assert.equal(
    formatBackgroundResult("j1", { sessionFile: "", output: "nope", status: "failed" }),
    "Background task j1 failed: nope",
  );
});