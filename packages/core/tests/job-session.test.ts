import assert from "node:assert/strict";
import { test } from "node:test";
import { createJob, updateJob, type Job } from "@xzy-ai/core";

/**
 * F003 Phase 1 job-session-identity tests.
 *
 * Every job now carries the live session id of the child session it runs
 * (`sessionId`) and the live session id of the session that spawned it
 * (`parentSessionId`). For a fresh child the session id equals the job id; for
 * a resumed child the session id is the new resume job id (the copied
 * transcript header is rewritten). The fields are optional on legacy records
 * and are preserved by immutable updates.
 */

test("createJob defaults the session id to the job id and the parent session id to the parent job id", () => {
  const root = createJob({ jobId: "root", status: "created", description: "d", subagentType: "g" });
  assert.equal(root.sessionId, "root");
  assert.equal(root.parentSessionId, undefined);

  const child = createJob({
    jobId: "job-a",
    status: "created",
    description: "d",
    subagentType: "g",
    parentJobId: "root",
    rootJobId: "root",
    depth: 1,
  });
  assert.equal(child.sessionId, "job-a");
  assert.equal(child.parentSessionId, "root");
});

test("createJob records explicit session ids when the caller supplies them", () => {
  const resumed = createJob({
    jobId: "job-resumed",
    sessionId: "resumed-session-id",
    parentSessionId: "root-session-id",
    status: "created",
    description: "d",
    subagentType: "g",
    parentJobId: "job-original",
    rootJobId: "root",
    depth: 1,
  });
  assert.equal(resumed.sessionId, "resumed-session-id");
  assert.equal(resumed.parentSessionId, "root-session-id");
});

test("updateJob is immutable and preserves the session identity", () => {
  const job = createJob({
    jobId: "job-a",
    sessionId: "session-a",
    parentSessionId: "root-session",
    status: "created",
    description: "d",
    subagentType: "g",
  });
  const running = updateJob(job, { status: "running", updatedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(job.status, "created");
  assert.equal(running.sessionId, "session-a");
  assert.equal(running.parentSessionId, "root-session");
  assert.equal(running.updatedAt, "2026-01-01T00:00:00.000Z");
});

test("a fresh child job's session id equals its job id", () => {
  const job: Job = createJob({
    jobId: "job-1",
    status: "queued",
    description: "d",
    subagentType: "g",
    parentJobId: "parent",
    rootJobId: "parent",
    depth: 1,
  });
  assert.equal(job.sessionId, "job-1");
  assert.equal(job.parentSessionId, "parent");
});

test("legacy job records without session identity remain valid", () => {
  // A folded legacy log entry has no sessionId/parentSessionId fields; the
  // model must treat them as absent, not crash.
  const legacy = {
    jobId: "legacy-1",
    status: "completed",
    description: "d",
    subagentType: "g",
    parentJobId: undefined,
    rootJobId: "legacy-1",
    depth: 0,
    sessionFile: "/sessions/legacy-1.jsonl",
    usage: undefined,
    delivered: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } satisfies Job;
  assert.equal(legacy.sessionId, undefined);
  assert.equal(legacy.parentSessionId, undefined);
  assert.equal(legacy.rootJobId, "legacy-1");
});
