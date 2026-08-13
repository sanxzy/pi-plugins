import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REGISTRY_OPERATIONS, createSessionLogger, runWithLogContext } from "@xzy-ai/observability";
import { createJob } from "@xzy-ai/core";
import { createAgentEventRegistry, getChildPool, encodeProjectId, homeProjectDir } from "@xzy-ai/runtime";

function project(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-cache-project-"));
}

function setupHome(): string {
  const home = mkdtempSync(join(tmpdir(), "pi-code-cache-home-"));
  process.env.PI_CODE_TEST_HOME = home;
  return home;
}

test("agent registry load and ensureSession emit boundary records", () => {
  setupHome();
  const root = project();
  const logRoot = project();
  const logger = createSessionLogger({
    projectId: "project",
    rootSessionId: "root-session",
    eventsPath: join(logRoot, "events.jsonl"),
    errorsPath: join(logRoot, "errors.jsonl"),
  });
  runWithLogContext(logger, () => {
    const registry = createAgentEventRegistry(root, "root-session");
    registry.ensureSession("child-session");
    registry.refresh();
  });
  const records = readFileSync(join(logRoot, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const loadRecords = records.filter((record) => record.operation === REGISTRY_OPERATIONS.AGENT_LOAD);
  assert.ok(loadRecords.some((record) => record.phase === "before"), "AGENT_LOAD before record missing");
  assert.ok(loadRecords.some((record) => record.phase === "after"), "AGENT_LOAD after record missing");
  assert.deepEqual(
    records.filter((record) => record.operation === REGISTRY_OPERATIONS.AGENT_ENSURE_SESSION).map((record) => record.phase),
    ["before", "after"],
  );
  rmSync(root, { recursive: true, force: true });
  rmSync(logRoot, { recursive: true, force: true });
});

test("cached snapshot reflects in-process updates without rescaming home, then advances on refresh", () => {
  setupHome();
  const root = project();
  const eventsDir = join(homeProjectDir(encodeProjectId(root)), "sessions");
  const registry = createAgentEventRegistry(root, "root-session");
  registry.createJob(createJob({
    jobId: "agent-a",
    parentSessionId: "root-session",
    status: "queued",
    description: "agent-a",
    subagentType: "test-agent",
  }));
  registry.updateJob("agent-a", { status: "running" });

  // A snapshot read reflects the last in-memory state and never triggers a
  // synchronous home rescan.
  assert.equal(registry.snapshot().get("agent-a")?.status, "running");
  assert.equal(registry.snapshot().size >= 1, true);

  // Externally remove the job's home folder without any intervening
  // authoritative read. A stable snapshot keeps the in-memory state until an
  // explicit refresh advances it.
  rmSync(eventsDir, { recursive: true, force: true });
  assert.equal(registry.snapshot().get("agent-a")?.status, "running", "snapshot is stable across non-refreshing reads");

  // The authoritative refresh drops the externally removed job from the cache.
  registry.refresh();
  assert.equal(registry.snapshot().get("agent-a"), undefined, "refresh rebuilds the snapshot from authoritative home");
});

test("snapshot identity stays stable between refreshes and changes only after a lifecycle write", () => {
  setupHome();
  const root = project();
  const registry = createAgentEventRegistry(root, "root-session");
  const initial = registry.snapshot();
  assert.equal(registry.snapshot(), initial, "render reads reuse the same immutable snapshot reference");
  registry.createJob(createJob({
    jobId: "agent-b",
    parentSessionId: "root-session",
    status: "queued",
    description: "agent-b",
    subagentType: "test-agent",
  }));
  assert.notEqual(registry.snapshot(), initial, "lifecycle writes publish a new snapshot reference");
});

function loggerAt(logRoot: string) {
  return createSessionLogger({
    projectId: "project",
    rootSessionId: "root-session",
    eventsPath: join(logRoot, "events.jsonl"),
    errorsPath: join(logRoot, "errors.jsonl"),
  });
}

function recordsAt(logRoot: string): Array<Record<string, unknown>> {
  const path = join(logRoot, "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Red-phase regression gate for the spawn freeze: authoritative lookups must
 * serve the already-loaded in-memory model instead of re-scanning every home
 * event log synchronously on the main thread.
 */
test("authoritative lookups serve the in-memory model without rescanning home", () => {
  setupHome();
  const root = project();
  const seedLog = project();
  const probeLog = project();
  // Warm the registry before any logger exists; the construction load goes to
  // the silent logger and never persists telemetry.
  const registry = createAgentEventRegistry(root, "root-session");
  runWithLogContext(loggerAt(seedLog), () => {
    registry.createJob(createJob({
      jobId: "agent-a",
      parentSessionId: "root-session",
      status: "queued",
      description: "agent-a",
      subagentType: "test-agent",
    }));
    registry.updateJob("agent-a", { status: "running" });
  });
  runWithLogContext(loggerAt(probeLog), () => {
    assert.equal(registry.get("agent-a")?.status, "running");
    assert.equal(registry.getBySessionId("agent-a")?.jobId, "agent-a");
    assert.ok(registry.all().has("agent-a"));
    assert.ok(registry.fold().has("agent-a"));
    assert.ok(registry.registries().has("agent-a"));
  });
  assert.deepEqual(recordsAt(probeLog), [], "reads must not emit AGENT_LOAD or any telemetry");
  rmSync(root, { recursive: true, force: true });
  rmSync(seedLog, { recursive: true, force: true });
  rmSync(probeLog, { recursive: true, force: true });
});

/**
 * Red-phase regression gate: lifecycle writes publish to the in-memory model
 * and only touch the single store being written; they must not rescan the
 * whole project and must not prune while the retention cap is not exceeded.
 */
test("lifecycle writes publish in-memory state without rescanning or pruning under the cap", () => {
  setupHome();
  const root = project();
  const seedLog = project();
  const probeLog = project();
  const registry = createAgentEventRegistry(root, "root-session");
  runWithLogContext(loggerAt(seedLog), () => {
    registry.createJob(createJob({
      jobId: "agent-x",
      parentSessionId: "root-session",
      status: "queued",
      description: "agent-x",
      subagentType: "test-agent",
    }));
    registry.updateJob("agent-x", { status: "running" });
  });
  runWithLogContext(loggerAt(probeLog), () => {
    registry.createJob(createJob({
      jobId: "agent-y",
      parentSessionId: "root-session",
      status: "queued",
      description: "agent-y",
      subagentType: "test-agent",
    }));
    registry.updateJob("agent-y", { status: "running" });
    registry.updateJob("agent-y", { status: "completed" });
  });
  // In-memory publish is visible without any intervening rescan.
  assert.equal(registry.get("agent-y")?.status, "completed");
  assert.equal(registry.snapshot().get("agent-y")?.status, "completed");
  const probeRecords = recordsAt(probeLog);
  assert.equal(probeRecords.filter((record) => record.operation === REGISTRY_OPERATIONS.AGENT_LOAD).length, 0, "writes must not rescan home");
  assert.equal(probeRecords.filter((record) => record.operation === REGISTRY_OPERATIONS.AGENT_PRUNE).length, 0, "writes below the cap must not run prune");
  rmSync(root, { recursive: true, force: true });
  rmSync(seedLog, { recursive: true, force: true });
  rmSync(probeLog, { recursive: true, force: true });
});

/**
 * Red-phase regression gate: calling getChildPool on a surviving project
 * singleton must not refresh (full rescan) the registry. Previously every
 * reuse paid one full home rescan via upgradePool.
 */
test("getChildPool reuse on a surviving pool never rescans home", () => {
  setupHome();
  const root = project();
  const probeLog = project();
  const first = getChildPool(root, "root-session");
  runWithLogContext(loggerAt(probeLog), () => {
    assert.equal(getChildPool(root, "root-session"), first, "pool singleton identity is preserved");
  });
  assert.deepEqual(recordsAt(probeLog), [], "pool reuse must not emit AGENT_LOAD");
  rmSync(root, { recursive: true, force: true });
  rmSync(probeLog, { recursive: true, force: true });
});

/**
 * Composite scan regression: a logical read (get + getBySessionId + all +
 * fold + registries + snapshot) must perform no home rescan while the leaf
 * reads are in flight, and a lifecycle write must publish without rescanning.
 * This is the per-call cost model of a TUI repaint plus an agent spawn.
 */
test("composite read/write access performs no home rescan beyond construction", () => {
  setupHome();
  const root = project();
  const probeLog = project();
  const registry = createAgentEventRegistry(root, "root-session");
  registry.createJob(createJob({
    jobId: "agent-z",
    parentSessionId: "root-session",
    status: "queued",
    description: "agent-z",
    subagentType: "test-agent",
  }));
  registry.updateJob("agent-z", { status: "running" });
  runWithLogContext(loggerAt(probeLog), () => {
    assert.equal(registry.get("agent-z")?.status, "running");
    assert.ok(registry.all().has("agent-z"));
    assert.ok(registry.fold().has("agent-z"));
    assert.ok(registry.snapshot().has("agent-z"));
    registry.updateJob("agent-z", { status: "completed" });
  });
  const probeRecords = recordsAt(probeLog);
  assert.equal(probeRecords.filter((record) => record.operation === REGISTRY_OPERATIONS.AGENT_LOAD).length, 0);
  assert.equal(probeRecords.filter((record) => record.operation === REGISTRY_OPERATIONS.AGENT_PRUNE).length, 0);
  rmSync(root, { recursive: true, force: true });
  rmSync(probeLog, { recursive: true, force: true });
});
