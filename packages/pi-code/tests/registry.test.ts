import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJob, updateJob } from "../src/domain/jobs/job.ts";
import { canTransition, isTerminal } from "../src/domain/jobs/status.ts";
import { createRegistry, foldLog } from "../src/infrastructure/registry/registry.ts";

function tmpRegistryPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-code-registry-"));
  return join(dir, ".pi", "pi-code", "jobs.jsonl");
}

test("status state machine: legal transitions", () => {
  assert.equal(canTransition("created", "running"), true);
  assert.equal(canTransition("created", "queued"), true);
  assert.equal(canTransition("queued", "running"), true);
  assert.equal(canTransition("running", "completed"), true);
  assert.equal(canTransition("running", "failed"), true);
  assert.equal(canTransition("running", "cancelled"), true);
  assert.equal(isTerminal("completed"), true);
  assert.equal(isTerminal("running"), false);
});

test("status state machine: terminal states do not transition", () => {
  assert.equal(canTransition("completed", "running"), false);
  assert.equal(canTransition("cancelled", "queued"), false);
  assert.equal(canTransition("interrupted", "running"), false);
  assert.equal(canTransition("failed", "completed"), false);
});

test("createJob defaults to root lineage when no parent", () => {
  const job = createJob({
    jobId: "j1",
    status: "created",
    description: "d",
    subagentType: "general",
  });
  assert.equal(job.rootJobId, "j1");
  assert.equal(job.depth, 0);
  assert.equal(job.parentJobId, undefined);
  assert.equal(job.delivered, false);
  assert.equal(job.usage, undefined);
});

test("createJob derives lineage from parent", () => {
  const parent = createJob({ jobId: "p", status: "running", description: "p", subagentType: "g" });
  const child = createJob({
    jobId: "c",
    status: "created",
    description: "c",
    subagentType: "g",
    parentJobId: parent.jobId,
    rootJobId: parent.rootJobId,
    depth: parent.depth + 1,
  });
  assert.equal(child.rootJobId, "p");
  assert.equal(child.depth, 1);
  assert.equal(child.parentJobId, "p");
});

test("updateJob is immutable and preserves lineage", () => {
  const job = createJob({ jobId: "j1", status: "created", description: "d", subagentType: "g" });
  const running = updateJob(job, { status: "running", updatedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(job.status, "created");
  assert.equal(running.status, "running");
  assert.equal(running.jobId, "j1");
  assert.equal(running.rootJobId, "j1");
  assert.equal(running.depth, 0);
  assert.equal(running.updatedAt, "2026-01-01T00:00:00.000Z");
});

test("registry appends and folds a full lifecycle", () => {
  const filePath = tmpRegistryPath();
  const reg = createRegistry(filePath);
  const job = createJob({ jobId: "j1", status: "created", description: "d", subagentType: "g" });
  reg.createJob(job);
  reg.updateJob("j1", { status: "queued" });
  reg.updateJob("j1", { status: "running" });
  reg.updateJob("j1", { status: "completed" });

  const folded = reg.fold();
  const current = folded.get("j1");
  assert.ok(current);
  assert.equal(current.status, "completed");
  assert.equal(current.description, "d");
  assert.equal(current.rootJobId, "j1");

  const lines = readFileSync(filePath, "utf-8").trim().split("\n");
  assert.equal(lines.length, 4);
  assert.ok(lines.every((l) => l.startsWith("{")));
});

test("registry folds the exact transition timestamp", () => {
  const filePath = tmpRegistryPath();
  const reg = createRegistry(filePath);
  reg.createJob(createJob({ jobId: "j1", status: "created", description: "d", subagentType: "g" }));
  reg.updateJob("j1", { status: "running", updatedAt: "2026-01-01T00:00:00.000Z" });

  const current = reg.get("j1");
  const folded = foldLog(filePath).get("j1");
  assert.equal(current?.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(folded?.updatedAt, current?.updatedAt);
  assert.equal(folded?.createdAt, current?.createdAt);
  assert.equal(folded?.status, current?.status);
});

test("registry ignores illegal status transitions", () => {
  const filePath = tmpRegistryPath();
  const reg = createRegistry(filePath);
  reg.createJob(createJob({ jobId: "j1", status: "created", description: "d", subagentType: "g" }));
  reg.updateJob("j1", { status: "running" });
  reg.updateJob("j1", { status: "completed" });
  reg.updateJob("j1", { status: "running" });

  assert.equal(reg.get("j1")?.status, "completed");
  // created + running + completed = 3 lines; the illegal running update is dropped.
  assert.equal(readFileSync(filePath, "utf-8").trim().split("\n").length, 3);
  const folded = foldLog(filePath).get("j1");
  const current = reg.get("j1");
  assert.equal(folded?.jobId, current?.jobId);
  assert.equal(folded?.status, current?.status);
  assert.equal(folded?.rootJobId, current?.rootJobId);
  assert.equal(folded?.depth, current?.depth);
  assert.equal(folded?.createdAt, current?.createdAt);
  assert.equal(folded?.updatedAt, current?.updatedAt);
});

test("registry stores the exact session file path", () => {
  const filePath = tmpRegistryPath();
  const reg = createRegistry(filePath);
  const sessionPath = "/tmp/sessions/2026-01-01T00-00-00-000_j1.jsonl";
  const job = createJob({
    jobId: "j1",
    status: "running",
    description: "d",
    subagentType: "g",
    sessionFile: sessionPath,
  });
  reg.createJob(job);
  assert.equal(reg.get("j1")?.sessionFile, sessionPath);

  const folded = foldLog(filePath);
  assert.equal(folded.get("j1")?.sessionFile, sessionPath);
});

test("registry survives a fresh reader (durable fold)", () => {
  const filePath = tmpRegistryPath();
  const reg = createRegistry(filePath);
  reg.createJob(createJob({ jobId: "j1", status: "created", description: "d", subagentType: "g" }));
  reg.updateJob("j1", { status: "running" });

  const fresh = createRegistry(filePath);
  assert.equal(fresh.get("j1")?.status, "running");

  // Clean up the temp dir.
  rmSync(join(filePath, "..", "..", ".."), { recursive: true, force: true });
});

test("foldLog skips malformed lines without corrupting state", () => {
  const filePath = tmpRegistryPath();
  const reg = createRegistry(filePath);
  reg.createJob(createJob({ jobId: "j1", status: "created", description: "d", subagentType: "g" }));
  reg.updateJob("j1", { status: "running" });

  // Append a malformed line.
  appendFileSync(filePath, "{not json}\n");

  const folded = foldLog(filePath);
  assert.equal(folded.get("j1")?.status, "running");

  rmSync(join(filePath, "..", "..", ".."), { recursive: true, force: true });
});
