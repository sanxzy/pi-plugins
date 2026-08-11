import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJob } from "@xzy-ai/core";
import {
  createAgentEventRegistry,
  homeAgentEventsFile,
  homeAgentManifestFile,
  homeProjectDir,
  encodeProjectId,
  startRootSession,
  getChildPool,
  childSessionPaths,
} from "@xzy-ai/runtime";
import { makeJobId } from "@xzy-ai/tools";

function project(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-phase5-project-"));
}

function setupHome(): string {
  const home = mkdtempSync(join(tmpdir(), "pi-code-phase5-home-"));
  process.env.XZY_PI_CODE_HOME = home;
  return home;
}

function job(input: {
  id: string;
  parentSessionId: string;
  parentJobId?: string;
  status?: "created" | "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  createdAt?: string;
}) {
  return createJob({
    jobId: input.id,
    parentSessionId: input.parentSessionId,
    parentJobId: input.parentJobId,
    status: input.status ?? "queued",
    description: input.id,
    subagentType: "test-agent",
    createdAt: input.createdAt,
  });
}

test("scoped registry uses each agent event log and snapshot as its durable read model", () => {
  setupHome();
  const root = project();
  const registry = createAgentEventRegistry(root, "root-session");
  const child = job({ id: "agent-a", parentSessionId: "root-session" });
  registry.createJob(child);
  registry.updateJob(child.jobId, { status: "running" });
  registry.updateJob(child.jobId, { status: "completed", sessionFile: "/private/transcript.jsonl" });
  registry.updateJob(child.jobId, { delivered: true });

  const projectId = encodeProjectId(root);
  const eventsPath = homeAgentEventsFile(projectId, "root-session", "agent-a");
  const manifestPath = homeAgentManifestFile(projectId, "root-session", "agent-a");
  assert.equal(existsSync(eventsPath), true);
  assert.equal(existsSync(manifestPath), true);
  assert.equal(readFileSync(eventsPath, "utf8").trim().split("\n").length, 5);
  assert.equal(existsSync(join(homeProjectDir(projectId), "sessions", "root-session", "jobs-root-session.jsonl")), false);

  const fresh = createAgentEventRegistry(root, "root-session");
  const restored = fresh.get("agent-a");
  assert.equal(restored?.status, "completed");
  assert.equal(restored?.sessionFile, "/private/transcript.jsonl");
  assert.equal(restored?.delivered, true);
  assert.equal(restored?.parentSessionId, "root-session");
});

test("nested agent lineage and recursive visibility survive a fresh event-log read", () => {
  setupHome();
  const root = project();
  const registry = createAgentEventRegistry(root, "root-session");
  registry.createJob(job({ id: "parent", parentSessionId: "root-session", status: "running" }));
  registry.createJob({ ...job({ id: "grandchild", parentSessionId: "parent", parentJobId: "parent", status: "running" }), rootJobId: "parent" });
  const fresh = createAgentEventRegistry(root, "root-session");
  const child = fresh.get("grandchild");
  assert.equal(child?.parentJobId, "parent");
  assert.equal(child?.rootJobId, "parent");
  assert.equal(child?.depth, 1);
  assert.deepEqual(fresh.all().get("parent")?.rootJobId, "parent");
});

test("terminal retention trims only old terminal agents and keeps active records", () => {
  setupHome();
  const root = project();
  const registry = createAgentEventRegistry(root, "root-session");
  for (let index = 0; index < 27; index += 1) {
    const id = `terminal-${index}`;
    const created = job({ id, parentSessionId: "root-session", createdAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z` });
    registry.createJob(created);
    registry.updateJob(id, { status: "running" });
    registry.updateJob(id, { status: "completed" });
  }
  const active = job({ id: "active", parentSessionId: "root-session", status: "running", createdAt: "2026-01-01T00:01:00.000Z" });
  registry.createJob(active);
  const fresh = createAgentEventRegistry(root, "root-session");
  assert.equal(fresh.get("active")?.status, "running");
  assert.equal([...fresh.all().values()].filter((entry) => entry.status === "completed").length <= 25, true);
  assert.equal(fresh.get("terminal-0"), undefined);
});

test("terminal lifecycle transitions cannot be overwritten by later completion", () => {
  setupHome();
  const root = project();
  const registry = createAgentEventRegistry(root, "root-session");
  registry.createJob(job({ id: "race", parentSessionId: "root-session", status: "running" }));
  registry.updateJob("race", { status: "cancelled" });
  registry.updateJob("race", { status: "completed", sessionFile: "/late.jsonl" });
  assert.equal(registry.get("race")?.status, "cancelled");
  assert.equal(registry.get("race")?.sessionFile, undefined);
});

test("malformed or incomplete agent events do not break fresh readers", () => {
  setupHome();
  const root = project();
  const registry = createAgentEventRegistry(root, "root-session");
  registry.createJob(job({ id: "safe", parentSessionId: "root-session", status: "running" }));
  const events = registry.fileForJob("safe");
  assert.ok(events);
  appendFileSync(events, '{"type":"unknown","at":null}\\n{"type":"agent_updated"}\\n{broken\\n');
  const fresh = createAgentEventRegistry(root, "root-session");
  assert.equal(fresh.get("safe")?.status, "running");
});

test("event logs remain authoritative when the materialized snapshot is missing", () => {
  setupHome();
  const root = project();
  const registry = createAgentEventRegistry(root, "root-session");
  registry.createJob(job({ id: "snapshotless", parentSessionId: "root-session", status: "running" }));
  const events = registry.fileForJob("snapshotless");
  assert.ok(events);
  unlinkSync(events.replace("events.jsonl", "agent.json"));
  const fresh = createAgentEventRegistry(root, "root-session");
  assert.equal(fresh.get("snapshotless")?.status, "running");
  assert.equal(existsSync(events.replace("events.jsonl", "agent.json")), true);
});

test("prefixed job inputs use the same canonical transcript storage as unprefixed inputs", () => {
  setupHome();
  const root = project();
  assert.equal(
    childSessionPaths({ cwd: root, rootSessionId: "root-session", jobId: "job-same" }).agentDir,
    childSessionPaths({ cwd: root, rootSessionId: "root-session", jobId: "same" }).agentDir,
  );
});

test("root-versus-child detection uses the root session manifest boundary", () => {
  setupHome();
  const root = project();
  startRootSession({ projectRoot: root, sessionId: "root-session" });
  const pool = getChildPool(root, "root-session");
  assert.equal(pool.isRootSession("root-session"), true);
  assert.equal(pool.isRootSession("child-session"), false);
  const missing = getChildPool(project(), "unpersisted-root");
  assert.equal(missing.isRootSession("unpersisted-root"), false);
});

test("new canonical job IDs are unprefixed", () => {
  for (let index = 0; index < 20; index += 1) assert.equal(makeJobId().startsWith("job-"), false);
});
