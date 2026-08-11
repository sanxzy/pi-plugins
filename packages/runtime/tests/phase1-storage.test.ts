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
    subagentType: "test-agent",
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

test("scoped registry prunes terminal jobs beyond the cap, oldest first, keeping active jobs", () => {
  const root = projectRoot();
  const registry = createScopedRegistry(root);

  // 30 terminal jobs under one parent; creation times spread so update order is deterministic.
  for (let i = 0; i < 30; i++) {
    const id = `done-${String(i).padStart(2, "0")}`;
    registry.createJob(newJob({
      jobId: id,
      parentSessionId: "root-session",
      status: "completed",
      createdAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      updatedAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
    }));
  }

  assert.equal(registry.all().size, 25, "only the newest 25 terminal jobs are retained");
  assert.equal(registry.get("done-00"), undefined, "oldest terminal job is pruned");
  assert.equal(registry.get("done-04"), undefined, "an early terminal job is pruned");
  assert.ok(registry.get("done-29"), "newest terminal job is retained");
  assert.ok(registry.get("done-25"), "the 25th newest terminal job is retained");
});

test("scoped registry pruning keeps active jobs and their ancestors", () => {
  const root = projectRoot();
  const registry = createScopedRegistry(root);

  // A running parent with a running child and many completed siblings.
  registry.createJob(newJob({
    jobId: "parent",
    parentSessionId: "root-session",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
  }));
  registry.createJob(newJob({
    jobId: "child",
    parentSessionId: "parent",
    parentJobId: "parent",
    status: "running",
    createdAt: "2026-01-01T00:00:01.000Z",
  }));
  for (let i = 0; i < 30; i++) {
    registry.createJob(newJob({
      jobId: `sib-${String(i).padStart(2, "0")}`,
      parentSessionId: "root-session",
      status: "completed",
      createdAt: `2026-01-01T00:01:${String(i).padStart(2, "0")}.000Z`,
      updatedAt: `2026-01-01T00:01:${String(i).padStart(2, "0")}.000Z`,
    }));
  }

  assert.ok(registry.get("parent"), "running parent is never pruned");
  assert.ok(registry.get("child"), "running child is never pruned");
  assert.equal(
    [...registry.all().values()].filter((job) => job.status === "completed").length,
    25,
    "exactly 25 completed siblings remain",
  );
});

test("pruning caps each agent's own history recursively, so grandchildren are isolated", () => {
  const root = projectRoot();
  const registry = createScopedRegistry(root);

  // Root agent spawns 30 completed children, each no deeper.
  for (let i = 0; i < 30; i++) {
    registry.createJob(newJob({
      jobId: `root-child-${String(i).padStart(2, "0")}`,
      parentSessionId: "root-session",
      status: "completed",
      createdAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      updatedAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
    }));
  }
  // One of those children is itself an agent that spawns 30 completed grandchildren.
  registry.createJob(newJob({
    jobId: "agent-a",
    parentSessionId: "root-session",
    status: "completed",
    createdAt: "2026-01-01T00:01:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
  }));
  for (let i = 0; i < 30; i++) {
    registry.createJob(newJob({
      jobId: `grand-${String(i).padStart(2, "0")}`,
      parentSessionId: "agent-a",
      parentJobId: "agent-a",
      status: "completed",
      createdAt: `2026-01-01T00:02:${String(i).padStart(2, "0")}.000Z`,
      updatedAt: `2026-01-01T00:02:${String(i).padStart(2, "0")}.000Z`,
    }));
  }

  // Root's own history is capped at 25 (agent-a is the newest completed child).
  const rootChildren = [...registry.all().values()]
    .filter((job) => job.parentSessionId === "root-session")
    .filter((job) => job.status === "completed");
  assert.equal(rootChildren.length, 25, "root agent keeps 25 completed children");
  assert.ok(rootChildren.some((job) => job.jobId === "agent-a"), "agent-a is retained as root's newest child");
  assert.equal(registry.get("root-child-00"), undefined, "oldest root child is pruned");

  // Agent-a's own history is capped at 25 independently of the root.
  const grandchildren = [...registry.all().values()]
    .filter((job) => job.parentSessionId === "agent-a")
    .filter((job) => job.status === "completed");
  assert.equal(grandchildren.length, 25, "agent-a keeps 25 completed grandchildren");
  assert.equal(registry.get("grand-00"), undefined, "oldest grandchild is pruned");
  assert.ok(registry.get("grand-29"), "newest grandchild is retained");
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
