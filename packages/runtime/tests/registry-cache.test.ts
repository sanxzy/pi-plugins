import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REGISTRY_OPERATIONS, createSessionLogger, runWithLogContext } from "@xzy-ai/observability";
import { createJob } from "@xzy-ai/core";
import { createAgentEventRegistry, encodeProjectId, homeProjectDir } from "@xzy-ai/runtime";

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
  const loadRecords = records.filter((record) => record.operation === REGISTRY_OPERATIONS.AGENT_LOAD.toLowerCase());
  assert.ok(loadRecords.some((record) => record.phase === "before"), "AGENT_LOAD before record missing");
  assert.ok(loadRecords.some((record) => record.phase === "after"), "AGENT_LOAD after record missing");
  assert.deepEqual(
    records.filter((record) => record.operation === REGISTRY_OPERATIONS.AGENT_ENSURE_SESSION.toLowerCase()).map((record) => record.phase),
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
