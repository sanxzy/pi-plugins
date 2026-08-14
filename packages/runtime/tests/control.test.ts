import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJob, type Job } from "@xzy-ai/core";
import {
  canCancel,
  checkControlScope,
  resumeDisposition,
  statusFor,
  visibleJobs,
  type ControlCaller,
} from "@xzy-ai/core";
import { prepareResumeSessionFile } from "@xzy-ai/runtime";

/**
 * Phase 6 control-tool tests.
 *
 * Covers the pure control rules (`checkControlScope`, `canCancel`,
 * `resumeDisposition`, `statusFor`, `visibleJobs`) and the resume-file
 * boundary (header identity rewrite + trailing unresolved tool-call trim).
 * The registry is faked as an in-memory job map; no SDK session is needed.
 */

function makeJob(jobId: string, status = "queued", extra: Partial<Job> = {}): Job {
  const parentJobId = extra.parentJobId;
  const parentSessionId = extra.parentSessionId ?? (parentJobId ?? "root-session");
  return createJob({
    jobId,
    status: status as Job["status"],
    description: "d",
    subagentType: "test-agent",
    ...extra,
    parentJobId,
    parentSessionId,
  });
}

/** Parent-chain view over a job map, matching the registry seam. */
function getJobFrom(map: Map<string, Job>): (jobId: string) => Job | undefined {
  return (jobId) => map.get(jobId);
}

test("checkControlScope: the root orchestrator controls every job", () => {
  const jobs = new Map<string, Job>([["a", makeJob("a", "running")]]);
  const root: ControlCaller = { sessionId: "root-session", jobId: undefined };
  assert.deepEqual(checkControlScope(root, jobs.get("a")!, getJobFrom(jobs)), { allowed: true });
});

test("checkControlScope: a job may not control itself", () => {
  const jobs = new Map<string, Job>([["a", makeJob("a", "running")]]);
  const caller: ControlCaller = { sessionId: "a", jobId: "a" };
  assert.deepEqual(checkControlScope(caller, jobs.get("a")!, getJobFrom(jobs)), {
    allowed: false,
    reason: "not a descendant",
  });
});

test("checkControlScope: a caller controls its direct and deeper descendants", () => {
  // root -> a -> b -> c
  const jobs = new Map<string, Job>([
    ["a", makeJob("a", "running")],
    ["b", makeJob("b", "running", { parentJobId: "a", rootJobId: "a", depth: 1 })],
    ["c", makeJob("c", "running", { parentJobId: "b", rootJobId: "a", depth: 2 })],
  ]);
  const caller: ControlCaller = { sessionId: "a", jobId: "a" };
  assert.deepEqual(checkControlScope(caller, jobs.get("b")!, getJobFrom(jobs)), { allowed: true });
  assert.deepEqual(checkControlScope(caller, jobs.get("c")!, getJobFrom(jobs)), { allowed: true });
});

test("checkControlScope: siblings and ancestors are not controllable", () => {
  // root a spawns b and d; b spawns c. From b's view, c is a descendant but a
  // (ancestor) and d (sibling) are not.
  const jobs = new Map<string, Job>([
    ["a", makeJob("a", "running")],
    ["b", makeJob("b", "running", { parentJobId: "a", rootJobId: "a", depth: 1 })],
    ["c", makeJob("c", "running", { parentJobId: "b", rootJobId: "a", depth: 2 })],
    ["d", makeJob("d", "running", { parentJobId: "a", rootJobId: "a", depth: 1 })],
  ]);
  const caller: ControlCaller = { sessionId: "b", jobId: "b" };
  assert.deepEqual(checkControlScope(caller, jobs.get("a")!, getJobFrom(jobs)), {
    allowed: false,
    reason: "not a descendant",
  });
  assert.deepEqual(checkControlScope(caller, jobs.get("d")!, getJobFrom(jobs)), {
    allowed: false,
    reason: "not a descendant",
  });
  assert.deepEqual(checkControlScope(caller, jobs.get("c")!, getJobFrom(jobs)), { allowed: true });
});

test("canCancel: running and queued in-scope jobs may be cancelled", () => {
  const jobs = new Map<string, Job>([
    ["a", makeJob("a", "running")],
    ["b", makeJob("b", "running", { parentJobId: "a", rootJobId: "a", depth: 1 })],
    ["c", makeJob("c", "queued", { parentJobId: "a", rootJobId: "a", depth: 1 })],
    ["done", makeJob("done", "completed", { parentJobId: "a", rootJobId: "a", depth: 1 })],
  ]);
  const caller: ControlCaller = { sessionId: "a", jobId: "a" };
  assert.deepEqual(canCancel(caller, jobs.get("b")!, getJobFrom(jobs)), { allowed: true });
  // A queued job has not started but is still cancellable: aborting its gate
  // controller prevents it from ever acquiring a concurrency slot.
  assert.deepEqual(canCancel(caller, jobs.get("c")!, getJobFrom(jobs)), { allowed: true });
  assert.equal(canCancel(caller, jobs.get("done")!, getJobFrom(jobs)).reason, "already terminal");
  // A sibling cannot be cancelled from a sibling's own view.
  const sibling: ControlCaller = { sessionId: "sib", jobId: "sib" };
  assert.equal(canCancel(sibling, jobs.get("b")!, getJobFrom(jobs)).reason, "not a descendant");
});

test("canCancel: created jobs are not cancellable", () => {
  const jobs = new Map<string, Job>([
    ["a", makeJob("a", "running")],
    ["created", makeJob("created", "created", { parentJobId: "a", rootJobId: "a", depth: 1 })],
  ]);
  const caller: ControlCaller = { sessionId: "a", jobId: "a" };
  assert.equal(canCancel(caller, jobs.get("created")!, getJobFrom(jobs)).reason, "not running");
});

test("resumeDisposition: running jobs are steered", () => {
  const jobs = new Map<string, Job>([
    ["a", makeJob("a", "running")],
    ["b", makeJob("b", "running", { parentJobId: "a", rootJobId: "a", depth: 1 })],
  ]);
  const disposition = resumeDisposition({ sessionId: "a", jobId: "a" }, jobs.get("b")!, getJobFrom(jobs));
  assert.equal(disposition.kind, "steer");
});

test("resumeDisposition: terminal jobs resume from their stored transcript", () => {
  const jobs = new Map<string, Job>([
    ["a", makeJob("a", "running")],
    [
      "done",
      makeJob("done", "interrupted", {
        parentJobId: "a",
        rootJobId: "a",
        depth: 1,
        sessionFile: "/sessions/done.jsonl",
      }),
    ],
  ]);
  const disposition = resumeDisposition({ sessionId: "a", jobId: "a" }, jobs.get("done")!, getJobFrom(jobs));
  assert.equal(disposition.kind, "resume");
});

test("resumeDisposition: a created job is rejected and a queued job resumes in place", () => {
  const jobs = new Map<string, Job>([
    ["a", makeJob("a", "running")],
    ["created", makeJob("created", "created", { parentJobId: "a", rootJobId: "a", depth: 1 })],
    ["queued", makeJob("queued", "queued", { parentJobId: "a", rootJobId: "a", depth: 1 })],
  ]);
  const caller: ControlCaller = { sessionId: "a", jobId: "a" };
  const created = resumeDisposition(caller, jobs.get("created")!, getJobFrom(jobs));
  assert.equal(created.kind, "reject");
  assert.equal(created.kind === "reject" ? created.reason : "", "not running");
  assert.equal(resumeDisposition(caller, jobs.get("queued")!, getJobFrom(jobs)).kind, "resume");
});

test("resumeDisposition: out-of-scope jobs are rejected", () => {
  const jobs = new Map<string, Job>([["other", makeJob("other", "interrupted")]]);
  const disposition = resumeDisposition({ sessionId: "a", jobId: "a" }, jobs.get("other")!, getJobFrom(jobs));
  assert.equal(disposition.kind, "reject");
  assert.equal(disposition.reason, "not a descendant");
});

test("visibleJobs: the root and nested callers list only direct children", () => {
  const jobs = new Map<string, Job>([
    ["a", makeJob("a", "running")],
    ["b", makeJob("b", "running", { parentJobId: "a", rootJobId: "a", depth: 1 })],
    ["c", makeJob("c", "running", { parentJobId: "b", rootJobId: "a", depth: 2 })],
    ["d", makeJob("d", "running", { parentJobId: "a", rootJobId: "a", depth: 1 })],
  ]);
  // The root orchestrator lists only the jobs it spawned directly; b, c, and d
  // belong to deeper lineage owned by the child that spawned them and are
  // never surfaced to an ancestor's listing.
  const rootVisible = visibleJobs({ sessionId: "root-session", jobId: undefined }, jobs.values(), getJobFrom(jobs)).map((j) => j.jobId);
  assert.deepEqual(rootVisible, ["a"]);

  // A nested caller lists only its direct children, never its own record,
  // grandchildren, or deeper descendants.
  const childVisible = visibleJobs({ sessionId: "b", jobId: "b" }, jobs.values(), getJobFrom(jobs)).map((j) => j.jobId);
  assert.deepEqual(childVisible, ["c"]);
});

test("visibleJobs never surfaces grandchildren or deeper job history", () => {
  // root -> a -> b -> c, plus root's other direct child d.
  const jobs = new Map<string, Job>([
    ["a", makeJob("a", "running", { parentSessionId: "root-session" })],
    ["b", makeJob("b", "running", { parentJobId: "a", rootJobId: "a", depth: 1 })],
    ["c", makeJob("c", "running", { parentJobId: "b", rootJobId: "a", depth: 2 })],
    ["d", makeJob("d", "completed", { parentSessionId: "root-session" })],
  ]);
  const getJob = getJobFrom(jobs);

  // Root: only the direct children it spawned; the grandchild chain is hidden.
  assert.deepEqual(visibleJobs({ sessionId: "root-session" }, jobs.values(), getJob).map((job) => job.jobId), ["a", "d"]);
  // Nested caller a: only direct child b; grandchild c stays with b.
  assert.deepEqual(visibleJobs({ sessionId: "a", jobId: "a" }, jobs.values(), getJob).map((job) => job.jobId), ["b"]);
});

test("statusFor: root controls everything, a child cannot control an ancestor", () => {
  const jobs = new Map<string, Job>([
    ["a", makeJob("a", "running")],
    ["b", makeJob("b", "running", { parentJobId: "a", rootJobId: "a", depth: 1 })],
  ]);
  assert.equal(statusFor({ sessionId: "root-session", jobId: undefined }, jobs.get("a")!, getJobFrom(jobs)).controllable, true);
  assert.equal(statusFor({ sessionId: "b", jobId: "b" }, jobs.get("a")!, getJobFrom(jobs)).controllable, false);
  assert.equal(statusFor({ sessionId: "b", jobId: "b" }, jobs.get("b")!, getJobFrom(jobs)).controllable, true);
});

test("session-scoped root callers cannot see or control another parent session", () => {
  const jobs = new Map<string, Job>([
    ["a-running", makeJob("a-running", "running", { parentSessionId: "root-a" })],
    ["a-done", makeJob("a-done", "completed", { parentJobId: "a-running", rootJobId: "a-running", depth: 1 })],
    ["a-cancelled", makeJob("a-cancelled", "cancelled", { parentJobId: "a-running", rootJobId: "a-running", depth: 1 })],
    ["b-running", makeJob("b-running", "running", { parentSessionId: "root-b" })],
    ["b-done", makeJob("b-done", "completed", { parentJobId: "b-running", rootJobId: "b-running", depth: 1 })],
    ["b-cancelled", makeJob("b-cancelled", "cancelled", { parentJobId: "b-running", rootJobId: "b-running", depth: 1 })],
  ]);
  const getJob = getJobFrom(jobs);
  const caller: ControlCaller = { sessionId: "root-a" };

  // The root lists only its direct children; a-done/a-cancelled are
  // grandchildren of the root session and stay with their own parent agent.
  assert.deepEqual(visibleJobs(caller, jobs.values(), getJob).map((job) => job.jobId), ["a-running"]);
  assert.deepEqual(checkControlScope(caller, jobs.get("a-running")!, getJob), { allowed: true });
  assert.deepEqual(checkControlScope(caller, jobs.get("b-running")!, getJob), {
    allowed: false,
    reason: "not a descendant",
  });
  assert.equal(statusFor(caller, jobs.get("b-done")!, getJob).controllable, false);
  assert.deepEqual(canCancel(caller, jobs.get("b-running")!, getJob), {
    allowed: false,
    reason: "not a descendant",
  });
  assert.deepEqual(resumeDisposition(caller, jobs.get("b-cancelled")!, getJob), {
    kind: "reject",
    reason: "not a descendant",
    job: jobs.get("b-cancelled"),
  });
});

test("a nested caller lists direct children, not descendants, siblings, or ancestors", () => {
  const jobs = new Map<string, Job>([
    ["a", makeJob("a", "running", { parentSessionId: "root-a" })],
    ["b", makeJob("b", "completed", { parentJobId: "a", rootJobId: "a", depth: 1 })],
    ["c", makeJob("c", "cancelled", { parentJobId: "b", rootJobId: "a", depth: 2 })],
    ["sibling", makeJob("sibling", "running", { parentSessionId: "root-a" })],
    ["other", makeJob("other", "running", { parentSessionId: "root-b" })],
  ]);
  const getJob = getJobFrom(jobs);
  const caller: ControlCaller = { sessionId: "a", jobId: "a", rootJobId: "a" };

  // Only direct children; grandchild c is owned by b.
  assert.deepEqual(visibleJobs(caller, jobs.values(), getJob).map((job) => job.jobId), ["b"]);
  assert.deepEqual(checkControlScope(caller, jobs.get("b")!, getJob), { allowed: true });
  assert.deepEqual(checkControlScope(caller, jobs.get("c")!, getJob), { allowed: true });
  assert.deepEqual(checkControlScope(caller, jobs.get("sibling")!, getJob), {
    allowed: false,
    reason: "not a descendant",
  });
  assert.deepEqual(checkControlScope(caller, jobs.get("other")!, getJob), {
    allowed: false,
    reason: "not a descendant",
  });
});

test("session scope accepts a rehydrated descendant when its parent chain is present", () => {
  const jobs = new Map<string, Job>([
    ["root-child", makeJob("root-child", "completed", { parentSessionId: "root-a" })],
    ["grandchild", makeJob("grandchild", "interrupted", { parentJobId: "root-child", rootJobId: "root-child", depth: 1 })],
  ]);
  const caller: ControlCaller = { sessionId: "root-a" };

  // The rehydrated child is listed; its own child (the grandchild) is not.
  assert.deepEqual(visibleJobs(caller, jobs.values(), getJobFrom(jobs)).map((job) => job.jobId), ["root-child"]);
});

test("prepareResumeSessionFile trims a trailing tool call in the same file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-c2-control-"));
  const source = join(dir, "original.jsonl");
  const header = { type: "session", version: 3, id: "original-job", timestamp: "t", cwd: dir };
  const assistant = {
    type: "message",
    id: "m1",
    parentId: null,
    timestamp: "t",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "thinking" },
        { type: "toolCall", id: "call-1", name: "agent", arguments: "{}" },
      ],
    },
  };
  writeFileSync(source, `${JSON.stringify(header)}\n${JSON.stringify(assistant)}\n`);

  const destination = prepareResumeSessionFile(source, "original-job");

  // The existing transcript is prepared and rewritten in place.
  assert.equal(destination, source);
  const lines = readFileSync(destination, "utf-8").trim().split("\n");
  assert.equal(lines.length, 2);
  const reusedHeader = JSON.parse(lines[0]) as { id?: string };
  assert.equal(reusedHeader.id, "original-job");

  const message = JSON.parse(lines[1]) as { message: { content: unknown[] } };
  assert.deepEqual(message.message.content, [{ type: "text", text: "thinking" }]);
  assert.equal(readFileSync(source, "utf-8").includes("toolCall"), false);
});

test("prepareResumeSessionFile drops a trailing assistant message whose content empties", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-c2-control-"));
  const source = join(dir, "original.jsonl");
  const header = { type: "session", version: 3, id: "original-job", timestamp: "t", cwd: dir };
  const assistant = {
    type: "message",
    id: "m1",
    parentId: null,
    timestamp: "t",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "agent", arguments: "{}" }],
    },
  };
  writeFileSync(source, `${JSON.stringify(header)}\n${JSON.stringify(assistant)}\n`);

  const destination = prepareResumeSessionFile(source, "original-job");
  const lines = readFileSync(destination, "utf-8").trim().split("\n");
  // Only the header remains.
  assert.equal(lines.length, 1);
  assert.ok(existsSync(source));
});

test("prepareResumeSessionFile preserves a normal completed transcript unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-c2-control-"));
  const source = join(dir, "original.jsonl");
  const header = { type: "session", version: 3, id: "original-job", timestamp: "t", cwd: dir };
  const assistant = {
    type: "message",
    id: "m1",
    parentId: null,
    timestamp: "t",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    },
  };
  const user = {
    type: "message",
    id: "m2",
    parentId: "m1",
    timestamp: "t",
    message: { role: "user", content: "keep going" },
  };
  writeFileSync(source, `${JSON.stringify(header)}\n${JSON.stringify(assistant)}\n${JSON.stringify(user)}\n`);

  const destination = prepareResumeSessionFile(source, "original-job");
  assert.equal(destination, source);
  const lines = readFileSync(destination, "utf-8").trim().split("\n");
  assert.equal(lines.length, 3);
  const last = JSON.parse(lines[2]) as { message: { role?: string } };
  assert.equal(last.message.role, "user");
});