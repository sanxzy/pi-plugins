import assert from "node:assert/strict";
import { test } from "node:test";
import { createJob, type Job, type JobUpdate } from "@xzy-ai/core";
import { canTransition } from "@xzy-ai/core";
import {
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
    subagentType: "default",
    sessionFile,
  });
}

function createFakeRegistry(jobs: Job[]): {
  jobs: Map<string, Job>;
  all(): Map<string, Job>;
  updateJob(jobId: string, update: JobUpdate): void;
} {
  const state = new Map(jobs.map((job) => [job.jobId, job]));
  return {
    jobs: state,
    all: () => state,
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
