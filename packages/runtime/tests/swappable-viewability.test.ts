import assert from "node:assert/strict";
import { test } from "node:test";
import { createJob, type ChildSessionControl, type ChildLiveSnapshot } from "@xzy-ai/core";
import { scopeDescendants } from "@xzy-ai/runtime";

function liveControl(): ChildSessionControl {
  return {
    sessionFile: undefined,
    steer: async () => {},
    abort: async () => {},
  } as unknown as ChildSessionControl;
}

function snapshot(status: ChildLiveSnapshot["status"] = "completed"): ChildLiveSnapshot {
  return {
    status,
    settled: true,
    transcript: [{ id: "m1", kind: "message", role: "assistant", text: "hello", complete: true }],
    counters: { toolUses: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  } as ChildLiveSnapshot;
}

function newJob(input: {
  jobId: string;
  parentSessionId?: string;
  status?: "created" | "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
}) {
  return createJob({
    jobId: input.jobId,
    sessionId: input.jobId,
    parentSessionId: input.parentSessionId ?? "root-session",
    parentJobId: undefined,
    status: input.status ?? "queued",
    description: input.jobId,
    subagentType: "test-agent",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

// Phase 1: running with live is viewable
test("running child with live handle is viewable", () => {
  const jobs = new Map([
    ["job-a", newJob({ jobId: "job-a", status: "running" })],
  ]);
  const live = new Map<string, ChildSessionControl>([["job-a", liveControl()]]);
  const rows = scopeDescendants(() => jobs.get("job-a"), jobs, "root-session", live, new Date("2026-01-01T00:00:10.000Z"));
  assert.equal(rows[0]?.enterable, true);
});

// Phase 1: completed with retained within retention is viewable
test("completed child with retained snapshot is viewable", () => {
  const jobs = new Map([
    ["job-a", { ...newJob({ jobId: "job-a", status: "completed" }), updatedAt: "2026-01-01T00:00:05.000Z" }],
  ]);
  const live = new Map<string, ChildSessionControl>();
  const retained = new Map<string, ChildLiveSnapshot>([["job-a", snapshot("completed")]]);
  const rows = (scopeDescendants as unknown as (
    getJob: (id: string) => any,
    jobs: Map<string, any>,
    root: string,
    live: Map<string, ChildSessionControl>,
    now: Date,
    retained?: Map<string, ChildLiveSnapshot>,
  ) => any)(() => jobs.get("job-a"), jobs, "root-session", live, new Date("2026-01-01T00:00:10.000Z"), retained);
  assert.equal(rows[0]?.enterable, true, "completed with retained should be enterable");
});

test("failed child with retained snapshot is viewable", () => {
  const jobs = new Map([
    ["job-a", { ...newJob({ jobId: "job-a", status: "failed" }), updatedAt: "2026-01-01T00:00:05.000Z" }],
  ]);
  const live = new Map<string, ChildSessionControl>();
  const retained = new Map<string, ChildLiveSnapshot>([["job-a", snapshot("failed")]]);
  const rows = (scopeDescendants as unknown as any)(() => jobs.get("job-a"), jobs, "root-session", live, new Date("2026-01-01T00:00:10.000Z"), retained);
  assert.equal(rows[0]?.enterable, true, "failed with retained should be enterable");
});

// queued never viewable even with live/retained
test("queued child is never viewable even if live handle exists", () => {
  const jobs = new Map([
    ["job-a", newJob({ jobId: "job-a", status: "queued" })],
  ]);
  const live = new Map<string, ChildSessionControl>([["job-a", liveControl()]]);
  const retained = new Map<string, ChildLiveSnapshot>([["job-a", snapshot("completed")]]);
  const rows = (scopeDescendants as unknown as any)(() => jobs.get("job-a"), jobs, "root-session", live, new Date("2026-01-01T00:00:10.000Z"), retained);
  assert.equal(rows[0]?.enterable, false, "queued must never be enterable");
});

test("completed without retained is not viewable", () => {
  const jobs = new Map([
    ["job-a", { ...newJob({ jobId: "job-a", status: "completed" }), updatedAt: "2026-01-01T00:00:05.000Z" }],
  ]);
  const live = new Map<string, ChildSessionControl>();
  const rows = (scopeDescendants as unknown as any)(() => jobs.get("job-a"), jobs, "root-session", live, new Date("2026-01-01T00:00:10.000Z"), new Map());
  assert.equal(rows[0]?.enterable, false, "completed without retained stays not enterable");
});
