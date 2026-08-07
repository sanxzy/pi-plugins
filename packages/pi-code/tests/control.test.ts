import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJob, type Job } from "../src/domain/jobs/job.ts";
import {
  canCancel,
  checkControlScope,
  resumeDisposition,
  statusFor,
  visibleJobs,
  type ControlCaller,
} from "../src/application/control/control.ts";
import { prepareResumeSessionFile } from "../src/infrastructure/sessions/resume-file.ts";

/**
 * Phase 6 control-tool tests.
 *
 * Covers the pure control rules (`checkControlScope`, `canCancel`,
 * `resumeDisposition`, `statusFor`, `visibleJobs`) and the resume-file
 * boundary (header identity rewrite + trailing unresolved tool-call trim).
 * The registry is faked as an in-memory job map; no SDK session is needed.
 */

function makeJob(jobId: string, status = "queued", extra: Partial<Job> = {}): Job {
  const job = createJob({
    jobId,
    status: status as Job["status"],
    description: "d",
    subagentType: "default",
    ...extra,
  });
  return extra.parentJobId !== undefined
    ? { ...job, parentJobId: extra.parentJobId, rootJobId: extra.rootJobId ?? job.rootJobId, depth: extra.depth ?? job.depth }
    : job;
}

/** Parent-chain view over a job map, matching the registry seam. */
function getJobFrom(map: Map<string, Job>): (jobId: string) => Job | undefined {
  return (jobId) => map.get(jobId);
}

test("checkControlScope: the root orchestrator controls every job", () => {
  const jobs = new Map<string, Job>([["a", makeJob("a", "running")]]);
  const root: ControlCaller = { jobId: undefined };
  assert.deepEqual(checkControlScope(root, jobs.get("a")!, getJobFrom(jobs)), { allowed: true });
});

test("checkControlScope: a job may not control itself", () => {
  const jobs = new Map<string, Job>([["a", makeJob("a", "running")]]);
  const caller: ControlCaller = { jobId: "a" };
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
  const caller: ControlCaller = { jobId: "a" };
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
  const caller: ControlCaller = { jobId: "b" };
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

test("canCancel: only a running in-scope job may be cancelled", () => {
  const jobs = new Map<string, Job>([
    ["a", makeJob("a", "running")],
    ["b", makeJob("b", "running", { parentJobId: "a", rootJobId: "a", depth: 1 })],
    ["c", makeJob("c", "queued", { parentJobId: "a", rootJobId: "a", depth: 1 })],
    ["done", makeJob("done", "completed", { parentJobId: "a", rootJobId: "a", depth: 1 })],
  ]);
  const caller: ControlCaller = { jobId: "a" };
  assert.deepEqual(canCancel(caller, jobs.get("b")!, getJobFrom(jobs)), { allowed: true });
  assert.equal(canCancel(caller, jobs.get("c")!, getJobFrom(jobs)).reason, "not running");
  assert.equal(canCancel(caller, jobs.get("done")!, getJobFrom(jobs)).reason, "already terminal");
  // A sibling cannot be cancelled from a sibling's own view.
  const sibling: ControlCaller = { jobId: "sib" };
  assert.equal(canCancel(sibling, jobs.get("b")!, getJobFrom(jobs)).reason, "not a descendant");
});

test("resumeDisposition: running jobs are steered", () => {
  const jobs = new Map<string, Job>([
    ["a", makeJob("a", "running")],
    ["b", makeJob("b", "running", { parentJobId: "a", rootJobId: "a", depth: 1 })],
  ]);
  const disposition = resumeDisposition({ jobId: "a" }, jobs.get("b")!, getJobFrom(jobs));
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
  const disposition = resumeDisposition({ jobId: "a" }, jobs.get("done")!, getJobFrom(jobs));
  assert.equal(disposition.kind, "resume");
});

test("resumeDisposition: a created job re-spawns fresh and a queued job resumes", () => {
  const jobs = new Map<string, Job>([
    ["a", makeJob("a", "running")],
    ["created", makeJob("created", "created", { parentJobId: "a", rootJobId: "a", depth: 1 })],
    ["queued", makeJob("queued", "queued", { parentJobId: "a", rootJobId: "a", depth: 1 })],
  ]);
  const caller: ControlCaller = { jobId: "a" };
  assert.equal(resumeDisposition(caller, jobs.get("created")!, getJobFrom(jobs)).kind, "fresh-spawn");
  assert.equal(resumeDisposition(caller, jobs.get("queued")!, getJobFrom(jobs)).kind, "resume");
});

test("resumeDisposition: out-of-scope jobs are rejected", () => {
  const jobs = new Map<string, Job>([["other", makeJob("other", "interrupted")]]);
  const disposition = resumeDisposition({ jobId: "a" }, jobs.get("other")!, getJobFrom(jobs));
  assert.equal(disposition.kind, "reject");
  assert.equal(disposition.reason, "not a descendant");
});

test("visibleJobs: the root sees everything, a child sees its own lineage", () => {
  const jobs = new Map<string, Job>([
    ["a", makeJob("a", "running")],
    ["b", makeJob("b", "running", { parentJobId: "a", rootJobId: "a", depth: 1 })],
    ["c", makeJob("c", "running", { parentJobId: "b", rootJobId: "a", depth: 2 })],
    ["d", makeJob("d", "running", { parentJobId: "a", rootJobId: "a", depth: 1 })],
  ]);
  const rootVisible = visibleJobs({ jobId: undefined }, jobs.values(), getJobFrom(jobs)).map((j) => j.jobId);
  assert.deepEqual(rootVisible, ["a", "b", "c", "d"]);

  const childVisible = visibleJobs({ jobId: "b" }, jobs.values(), getJobFrom(jobs)).map((j) => j.jobId);
  assert.deepEqual(childVisible, ["b", "c"]);
});

test("statusFor: root controls everything, a child cannot control an ancestor", () => {
  const jobs = new Map<string, Job>([
    ["a", makeJob("a", "running")],
    ["b", makeJob("b", "running", { parentJobId: "a", rootJobId: "a", depth: 1 })],
  ]);
  assert.equal(statusFor({ jobId: undefined }, jobs.get("a")!, getJobFrom(jobs)).controllable, true);
  assert.equal(statusFor({ jobId: "b" }, jobs.get("a")!, getJobFrom(jobs)).controllable, false);
  assert.equal(statusFor({ jobId: "b" }, jobs.get("b")!, getJobFrom(jobs)).controllable, true);
});

test("prepareResumeSessionFile rewrites the header id and trims a trailing tool call", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-code-control-"));
  const source = join(dir, "source.jsonl");
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

  const destination = prepareResumeSessionFile(source, "new-job", dir);

  // The new session file exists and keeps the original entry count (trim only
  // drops content, not the whole message here).
  const lines = readFileSync(destination, "utf-8").trim().split("\n");
  assert.equal(lines.length, 2);
  const copiedHeader = JSON.parse(lines[0]) as { id?: string };
  assert.equal(copiedHeader.id, "new-job");

  const copiedMessage = JSON.parse(lines[1]) as { message: { content: unknown[] } };
  assert.deepEqual(copiedMessage.message.content, [{ type: "text", text: "thinking" }]);
  // The original transcript is untouched.
  assert.equal(readFileSync(source, "utf-8").includes("toolCall"), true);
});

test("prepareResumeSessionFile drops a trailing assistant message whose content empties", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-code-control-"));
  const source = join(dir, "source.jsonl");
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

  const destination = prepareResumeSessionFile(source, "new-job", dir);
  const lines = readFileSync(destination, "utf-8").trim().split("\n");
  // Only the rewritten header remains.
  assert.equal(lines.length, 1);
  assert.equal(existsSync(source), true);
});

test("prepareResumeSessionFile preserves a normal completed transcript", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-code-control-"));
  const source = join(dir, "source.jsonl");
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

  const destination = prepareResumeSessionFile(source, "new-job", dir);
  const lines = readFileSync(destination, "utf-8").trim().split("\n");
  assert.equal(lines.length, 3);
  const last = JSON.parse(lines[2]) as { message: { role?: string } };
  assert.equal(last.message.role, "user");
});