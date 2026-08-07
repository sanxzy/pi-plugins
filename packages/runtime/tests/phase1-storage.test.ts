import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJob, type ChildSessionControl } from "@xzy-ai/core";
import {
  childSessionDir,
  createScopedRegistry,
  rootSessionDir,
  scopedRegistryFile,
  scopeDescendants,
  scopeRegistry,
  sessionRegistryFile,
} from "@xzy-ai/runtime";

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-phase1-"));
}

function liveControl(): ChildSessionControl {
  return {
    sessionFile: undefined,
    steer: async () => {},
    abort: async () => {},
  };
}

function newJob(input: {
  jobId: string;
  sessionId?: string;
  parentSessionId?: string;
  parentJobId?: string;
  status?: "created" | "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  createdAt?: string;
  updatedAt?: string;
}) {
  const job = createJob({
    jobId: input.jobId,
    sessionId: input.sessionId ?? input.jobId,
    parentSessionId: input.parentSessionId,
    parentJobId: input.parentJobId,
    status: input.status ?? "queued",
    description: input.jobId,
    subagentType: "default",
    createdAt: input.createdAt,
  });
  return input.updatedAt === undefined ? job : { ...job, updatedAt: input.updatedAt };
}

test("session path helpers create parent-scoped registry and child transcript directories", () => {
  const root = projectRoot();
  assert.equal(rootSessionDir(root, "root-session"), join(root, ".pi", "pi-code", "sessions", "root-session"));
  assert.equal(childSessionDir(root, "parent-session"), join(root, ".pi", "pi-code", "sessions", "parent-session"));
  assert.equal(
    sessionRegistryFile(root, "parent-session"),
    join(root, ".pi", "pi-code", "sessions", "parent-session", "jobs-parent-session.jsonl"),
  );
  assert.equal(scopedRegistryFile(root, "parent-session"), sessionRegistryFile(root, "parent-session"));
});

test("root session folder is created without a root job", () => {
  const root = projectRoot();
  const registry = createScopedRegistry(root);
  registry.ensureSession("root-session");
  assert.equal(existsSync(rootSessionDir(root, "root-session")), true);
  assert.equal(existsSync(sessionRegistryFile(root, "root-session")), false);
});

test("fresh and nested jobs are persisted in their immediate parent's registry folder", () => {
  const root = projectRoot();
  const registry = createScopedRegistry(root);
  registry.ensureSession("root-session");

  const child = newJob({ jobId: "job-a", parentSessionId: "root-session", parentJobId: undefined });
  registry.createJob(child);
  const grandchild = newJob({
    jobId: "job-c",
    parentSessionId: "job-a",
    parentJobId: "job-a",
  });
  registry.createJob(grandchild);

  assert.equal(existsSync(sessionRegistryFile(root, "root-session")), true);
  assert.equal(existsSync(sessionRegistryFile(root, "job-a")), true);
  assert.equal(registry.get("job-a")?.parentSessionId, "root-session");
  assert.equal(registry.get("job-c")?.parentSessionId, "job-a");
  assert.equal(registry.fileForJob("job-a"), sessionRegistryFile(root, "root-session"));
  assert.equal(registry.fileForJob("job-c"), sessionRegistryFile(root, "job-a"));
});

test("scope API recursively returns descendants, status, duration, and live enterability", () => {
  const root = projectRoot();
  const registry = createScopedRegistry(root);
  const started = "2026-01-01T00:00:00.000Z";
  const now = "2026-01-01T00:00:10.000Z";
  registry.createJob(newJob({
    jobId: "job-a",
    parentSessionId: "root-session",
    status: "running",
    createdAt: started,
    updatedAt: started,
  }));
  registry.createJob(newJob({
    jobId: "job-c",
    parentSessionId: "job-a",
    parentJobId: "job-a",
    status: "completed",
    createdAt: started,
    updatedAt: now,
  }));
  registry.createJob(newJob({
    jobId: "job-b",
    parentSessionId: "root-session",
    status: "queued",
    createdAt: started,
    updatedAt: started,
  }));

  const liveChildren = new Map<string, ChildSessionControl>([["job-a", liveControl()]]);
  const rootScope = scopeDescendants(
    (jobId) => registry.get(jobId),
    registry.all(),
    "root-session",
    liveChildren,
    new Date(now),
  );
  assert.deepEqual(rootScope.map((entry) => entry.jobId), ["job-a", "job-c", "job-b"]);
  assert.equal(rootScope[0]?.status, "running");
  assert.equal(rootScope[0]?.enterable, true);
  assert.equal(rootScope[0]?.durationMs, 10_000);
  assert.equal(rootScope[1]?.status, "completed");
  assert.equal(rootScope[1]?.enterable, false);
  assert.equal(rootScope[1]?.durationMs, 10_000);
  assert.equal(rootScope[2]?.status, "queued");
  assert.equal(rootScope[2]?.enterable, false);

  const childScope = scopeDescendants(
    (jobId) => registry.get(jobId),
    registry.all(),
    "job-a",
    liveChildren,
    new Date(now),
  );
  assert.deepEqual(childScope.map((entry) => entry.jobId), ["job-c"]);
});

test("scope API never reads legacy flat jobs or sessions", () => {
  const root = projectRoot();
  const legacyRegistry = join(root, ".pi", "pi-code", "jobs.jsonl");
  mkdirSync(join(root, ".pi", "pi-code"), { recursive: true });
  writeFileSync(legacyRegistry, JSON.stringify({ type: "created", job: newJob({ jobId: "legacy", parentSessionId: "root-session" }), at: "2026-01-01T00:00:00.000Z" }) + "\n");
  mkdirSync(join(root, ".pi", "pi-code", "sessions"), { recursive: true });
  writeFileSync(join(root, ".pi", "pi-code", "sessions", "legacy.jsonl"), "legacy transcript\n");

  const registry = createScopedRegistry(root);
  assert.deepEqual(scopeRegistry(registry, "root-session", new Map()), []);
  assert.deepEqual(registry.all(), new Map());
});
