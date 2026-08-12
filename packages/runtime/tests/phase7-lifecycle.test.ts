import assert from "node:assert/strict";
import { test } from "node:test";
import { createJob, type Job, type JobUpdate } from "@xzy-ai/core";
import { canTransition } from "@xzy-ai/core";
import {
  abortJobTree,
  createInterruptionSweep,
  interruptRunningJobs,
} from "@xzy-ai/runtime";
import { createDeliveryCoordinator } from "@xzy-ai/runtime";
import type { ChildSessionControl } from "@xzy-ai/core";

function makeJob(jobId: string, status: Job["status"], sessionFile?: string): Job {
  return createJob({
    jobId,
    status,
    description: jobId,
    subagentType: "test-agent",
    sessionFile,
  });
}

function createFakeRegistry(jobs: Job[]): {
  jobs: Map<string, Job>;
  all(): Map<string, Job>;
  get(jobId: string): Job | undefined;
  updateJob(jobId: string, update: JobUpdate): void;
} {
  const state = new Map(jobs.map((job) => [job.jobId, job]));
  return {
    jobs: state,
    all: () => state,
    get: (jobId) => state.get(jobId),
    updateJob(jobId, update): void {
      const current = state.get(jobId);
      if (!current) return;
      if (update.status !== undefined && !canTransition(current.status, update.status)) return;
      state.set(jobId, { ...current, ...update });
    },
  };
}

function control(abort: () => Promise<void>): ChildSessionControl {
  return {
    sessionFile: undefined,
    steer: async () => {},
    abort,
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test("interruptRunningJobs marks every running job interrupted and aborts live children", async () => {
  const registry = createFakeRegistry([
    makeJob("running-a", "running", "/sessions/a.jsonl"),
    makeJob("running-b", "running"),
    makeJob("queued", "queued"),
    makeJob("done", "completed", "/sessions/done.jsonl"),
  ]);
  const aborted: string[] = [];
  const liveChildren = new Map<string, ChildSessionControl>([
    ["running-a", control(async () => { aborted.push("running-a"); })],
    ["running-b", control(async () => { aborted.push("running-b"); })],
  ]);

  await interruptRunningJobs({ registry, liveChildren });

  assert.equal(registry.jobs.get("running-a")?.status, "interrupted");
  assert.equal(registry.jobs.get("running-b")?.status, "interrupted");
  assert.equal(registry.jobs.get("queued")?.status, "queued");
  assert.equal(registry.jobs.get("done")?.status, "completed");
  assert.deepEqual(aborted.sort(), ["running-a", "running-b"]);
});

test("a session-scoped sweep interrupts and cancels every active job in the parent session's tree", async () => {
  const registry = createFakeRegistry([
    makeJob("a-running", "running"),
    makeJob("a-child", "running"),
    makeJob("a-queued", "queued"),
    makeJob("a-done", "completed"),
    makeJob("b-running", "running"),
    makeJob("b-queued", "queued"),
  ]);
  // Wire the parent-session lineage so the tree projection can walk it.
  const a = registry.get("a-running")!;
  registry.jobs.set("a-running", { ...a, parentSessionId: "root-a" });
  const ac = registry.get("a-child")!;
  registry.jobs.set("a-child", { ...ac, parentSessionId: "a-running", parentJobId: "a-running" });
  const aq = registry.get("a-queued")!;
  registry.jobs.set("a-queued", { ...aq, parentSessionId: "a-running", parentJobId: "a-running" });
  const ad = registry.get("a-done")!;
  registry.jobs.set("a-done", { ...ad, parentSessionId: "a-running", parentJobId: "a-running" });
  const b = registry.get("b-running")!;
  registry.jobs.set("b-running", { ...b, parentSessionId: "root-b" });
  const bq = registry.get("b-queued")!;
  registry.jobs.set("b-queued", { ...bq, parentSessionId: "root-b" });

  const aborted: string[] = [];
  const liveChildren = new Map<string, ChildSessionControl>([
    ["a-running", control(async () => { aborted.push("a-running"); })],
    ["a-child", control(async () => { aborted.push("a-child"); })],
    ["b-running", control(async () => { aborted.push("b-running"); })],
  ]);

  await interruptRunningJobs({ registry, liveChildren, rootSessionId: "root-a" });

  assert.equal(registry.get("a-running")?.status, "interrupted");
  assert.equal(registry.get("a-child")?.status, "interrupted");
  assert.equal(registry.get("a-queued")?.status, "cancelled");
  assert.equal(registry.get("a-done")?.status, "completed");
  assert.equal(registry.get("b-running")?.status, "running");
  assert.equal(registry.get("b-queued")?.status, "queued");
  assert.deepEqual(aborted.sort(), ["a-child", "a-running"]);
});

test("a session-scoped sweep cancels queued descendants so they never start", async () => {
  const registry = createFakeRegistry([
    makeJob("running", "running"),
    makeJob("queued", "queued"),
  ]);
  registry.jobs.set("running", { ...registry.get("running")!, parentSessionId: "root-a" });
  registry.jobs.set("queued", { ...registry.get("queued")!, parentSessionId: "running", parentJobId: "running" });

  const controllers = new Map<string, AbortController>([["queued", new AbortController()]]);
  const liveChildren = new Map<string, ChildSessionControl>([["running", control(async () => {})]]);

  await interruptRunningJobs({ registry, liveChildren, jobAbortControllers: controllers, rootSessionId: "root-a" });

  assert.equal(registry.get("queued")?.status, "cancelled");
  assert.equal(controllers.get("queued")!.signal.aborted, true, "the queued gate waiter must be aborted");
});

test("the interruption sweep tolerates a running job without a transcript or live control", async () => {
  const registry = createFakeRegistry([makeJob("no-transcript", "running")]);
  await interruptRunningJobs({ registry, liveChildren: new Map() });
  assert.equal(registry.jobs.get("no-transcript")?.status, "interrupted");
  assert.equal(registry.jobs.get("no-transcript")?.sessionFile, undefined);
});

test("an overlapping interruption sweep aborts each child once and is idempotent", async () => {
  const registry = createFakeRegistry([makeJob("running", "running")]);
  let abortCount = 0;
  let releaseAbort!: () => void;
  const abortFinished = new Promise<void>((resolve) => {
    releaseAbort = resolve;
  });
  const liveChildren = new Map<string, ChildSessionControl>([
    [
      "running",
      control(async () => {
        abortCount += 1;
        await abortFinished;
      }),
    ],
  ]);
  const sweep = createInterruptionSweep({ registry, liveChildren });
  const first = sweep();
  const second = sweep();
  assert.equal(first, second);
  releaseAbort();
  await Promise.all([first, second]);
  assert.equal(abortCount, 1);

  await sweep();
  assert.equal(abortCount, 1);
  assert.equal(registry.jobs.get("running")?.status, "interrupted");
});

test("aborting a parent aborts its descendants deepest-first", async () => {
  const registry = createFakeRegistry([
    makeJob("parent", "running"),
    makeJob("child", "running"),
    makeJob("grandchild", "running"),
  ]);
  registry.jobs.set("parent", { ...registry.get("parent")!, sessionId: "parent-session", parentSessionId: "root" });
  registry.jobs.set("child", { ...registry.get("child")!, sessionId: "child-session", parentSessionId: "parent-session", parentJobId: "parent" });
  registry.jobs.set("grandchild", { ...registry.get("grandchild")!, sessionId: "grandchild-session", parentSessionId: "child-session", parentJobId: "child" });
  const aborted: string[] = [];
  const liveChildren = new Map<string, ChildSessionControl>([
    ["parent", control(async () => { aborted.push("parent"); })],
    ["child", control(async () => { aborted.push("child"); })],
    ["grandchild", control(async () => { aborted.push("grandchild"); })],
  ]);

  await abortJobTree({ registry, liveChildren }, "parent");

  assert.deepEqual(aborted, ["grandchild", "child", "parent"]);
  assert.equal(registry.get("parent")?.status, "interrupted");
  assert.equal(registry.get("child")?.status, "interrupted");
  assert.equal(registry.get("grandchild")?.status, "interrupted");
});

test("aborting a parent and descendant control concurrently avoids a nested abort deadlock", async () => {
  const registry = createFakeRegistry([
    makeJob("parent", "running"),
    makeJob("child", "running"),
  ]);
  registry.jobs.set("parent", { ...registry.get("parent")!, sessionId: "parent-session", parentSessionId: "root" });
  registry.jobs.set("child", { ...registry.get("child")!, sessionId: "child-session", parentSessionId: "parent-session", parentJobId: "parent" });

  const parentAbortStarted = deferred<void>();
  const childAbortFinished = deferred<void>();
  const liveChildren = new Map<string, ChildSessionControl>([
    ["parent", control(async () => {
      parentAbortStarted.resolve();
      await childAbortFinished.promise;
    })],
    ["child", control(async () => {
      await parentAbortStarted.promise;
      childAbortFinished.resolve();
    })],
  ]);

  const result = await Promise.race([
    abortJobTree({ registry, liveChildren }, "parent").then(() => "completed" as const),
    new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 250)),
  ]);
  assert.equal(result, "completed");
  assert.equal(registry.get("parent")?.status, "interrupted");
  assert.equal(registry.get("child")?.status, "interrupted");
});

test("delivery rebind follows pending results into a fork descendant", () => {
  const delivery = createDeliveryCoordinator();
  delivery.deliverResult("job-1", "/sessions/parent.jsonl", "background result");
  assert.equal(delivery.pendingCount, 1);

  delivery.rebind("/sessions/parent.jsonl", "/sessions/fork.jsonl");
  const received: string[] = [];
  delivery.register("/sessions/fork.jsonl", (content) => received.push(content));

  assert.deepEqual(received, ["background result"]);
  assert.equal(delivery.pendingCount, 0);
});

test("delivery rebind leaves unrelated pending results untouched", () => {
  const delivery = createDeliveryCoordinator();
  delivery.deliverResult("job-a", "/sessions/parent.jsonl", "a");
  delivery.deliverResult("job-b", "/sessions/other.jsonl", "b");

  delivery.rebind("/sessions/parent.jsonl", "/sessions/fork.jsonl");
  const received: string[] = [];
  delivery.register("/sessions/fork.jsonl", (content) => received.push(content));

  assert.deepEqual(received, ["a"]);
  assert.equal(delivery.pendingCount, 1);
  const other: string[] = [];
  delivery.register("/sessions/other.jsonl", (content) => other.push(content));
  assert.deepEqual(other, ["b"]);
});
