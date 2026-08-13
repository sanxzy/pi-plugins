import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJob } from "@xzy-ai/core";
import { CHANNEL_OPERATIONS, createSessionLogger, runWithLogContext } from "@xzy-ai/observability";
import {
  channelConfigFile,
  channelOwnerFile,
  channelRuntimeFile,
  cleanupRootSessions,
  writeChannelConfig,
  writeChannelRuntime,
} from "../src/index.ts";
import {
  createAgentEventRegistry,
  encodeProjectId,
  homeSessionDir,
  homeSessionManifestFile,
  startRootSession,
} from "@xzy-ai/runtime";

function setup(): string {
  const home = mkdtempSync(join(tmpdir(), "pi-code-phase7-cleanup-home-"));
  process.env.PI_CODE_TEST_HOME = home;
  return home;
}
function project(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-phase7-cleanup-project-"));
}

function cleanupLog(): { eventsPath: string; errorsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-code-phase7-cleanup-log-"));
  return { eventsPath: join(dir, "events.jsonl"), errorsPath: join(dir, "errors.jsonl") };
}

function records(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("cleanupRootSessions logs its destructive cleanup boundary", () => {
  setup();
  const root = project();
  const paths = cleanupLog();
  const logger = createSessionLogger({ projectId: "project", rootSessionId: "root-session", ...paths });

  runWithLogContext(logger, () => {
    const result = cleanupRootSessions(root, {
      currentPid: 9999,
      currentProcessStartTime: "current-start",
      isAlive: () => false,
    });
    assert.equal(result.ok, true);
  });

  const cleanupRecords = records(paths.eventsPath).filter((record) => record.operation === CHANNEL_OPERATIONS.CLEANUP);
  assert.deepEqual(cleanupRecords.map((record) => record.phase), ["before", "after"]);
});

test("cleanup cancels all persisted non-terminal agents of a dead session", () => {
  setup();
  const root = project();
  startRootSession({ projectRoot: root, sessionId: "dead-root", pid: 1111, processStartTime: "old-start" });
  const registry = createAgentEventRegistry(root, "dead-root");
  registry.createJob(createJob({
    jobId: "queued-agent",
    parentSessionId: "dead-root",
    sessionId: "queued-agent",
    status: "queued",
    description: "queued",
    subagentType: "test-agent",
  }));
  registry.createJob(createJob({
    jobId: "running-agent",
    parentSessionId: "dead-root",
    sessionId: "running-agent",
    status: "running",
    description: "running",
    subagentType: "test-agent",
  }));
  registry.createJob(createJob({
    jobId: "terminal-agent",
    parentSessionId: "dead-root",
    sessionId: "terminal-agent",
    status: "completed",
    description: "completed",
    subagentType: "test-agent",
  }));

  const result = cleanupRootSessions(root, {
    currentPid: 9999,
    currentProcessStartTime: "current-start",
    isAlive: () => false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.cancelledAgents, 2, "both non-terminal agents are cancelled");
  // A parent shutdown is absolute: every recorded job in the dead session is
  // cancelled regardless of whether it had started (`running`) or not
  // (`queued`).
  const fresh = createAgentEventRegistry(root, "dead-root");
  assert.equal(fresh.get("queued-agent")?.status, "cancelled");
  assert.equal(fresh.get("running-agent")?.status, "cancelled");
  assert.equal(fresh.get("terminal-agent")?.status, "completed", "terminal records remain unchanged");
  assert.equal(JSON.parse(readFileSync(homeSessionManifestFile(encodeProjectId(root), "dead-root"), "utf8")).active, false);
});

test("cleanup cancels only the dead session's tree and leaves a live session untouched", () => {
  setup();
  const root = project();
  startRootSession({ projectRoot: root, sessionId: "dead-root", pid: 1111, processStartTime: "old-start" });
  startRootSession({ projectRoot: root, sessionId: "live-root", pid: 5555, processStartTime: "live-start" });
  const registry = createAgentEventRegistry(root, "dead-root");
  registry.createJob(createJob({
    jobId: "dead-queued",
    parentSessionId: "dead-root",
    sessionId: "dead-queued",
    status: "queued",
    description: "queued",
    subagentType: "test-agent",
  }));
  registry.createJob(createJob({
    jobId: "dead-running",
    parentSessionId: "dead-root",
    sessionId: "dead-running",
    status: "running",
    description: "running",
    subagentType: "test-agent",
  }));
  registry.createJob(createJob({
    jobId: "live-running",
    parentSessionId: "live-root",
    sessionId: "live-running",
    status: "running",
    description: "live",
    subagentType: "test-agent",
  }));
  registry.createJob(createJob({
    jobId: "live-queued",
    parentSessionId: "live-root",
    sessionId: "live-queued",
    status: "queued",
    description: "live",
    subagentType: "test-agent",
  }));
  registry.createJob(createJob({
    jobId: "live-done",
    parentSessionId: "live-root",
    sessionId: "live-done",
    status: "completed",
    description: "live",
    subagentType: "test-agent",
  }));

  const result = cleanupRootSessions(root, {
    currentPid: 9999,
    currentProcessStartTime: "current-start",
    isAlive: (pid) => pid === 5555,
  });
  assert.equal(result.ok, true);
  assert.equal(result.cancelledAgents, 2, "only the dead session's non-terminal agents are cancelled");
  const fresh = createAgentEventRegistry(root, "dead-root");
  assert.equal(fresh.get("dead-queued")?.status, "cancelled");
  assert.equal(fresh.get("dead-running")?.status, "cancelled");
  assert.equal(fresh.get("live-running")?.status, "running", "a live session's running job stays untouched");
  assert.equal(fresh.get("live-queued")?.status, "queued", "a live session's queued job stays untouched");
  assert.equal(fresh.get("live-done")?.status, "completed", "terminal records stay untouched");
  assert.equal(JSON.parse(readFileSync(homeSessionManifestFile(encodeProjectId(root), "dead-root"), "utf8")).active, false);
  assert.equal(JSON.parse(readFileSync(homeSessionManifestFile(encodeProjectId(root), "live-root"), "utf8")).active, true, "the live session manifest stays active");
});

test("cleanup prunes oldest inactive sessions even when active sessions alone exceed 200", () => {
  setup();
  const root = project();
  const current = { currentPid: 9999, currentProcessStartTime: "current-start" };
  // 202 active sessions alone exceed the 200 cap; Q57/AC-5 allow this to
  // temporarily exceed 200, but stale inactive sessions must still be pruned.
  for (let index = 0; index < 202; index += 1) {
    const id = `active-${String(index).padStart(3, "0")}`;
    startRootSession({ projectRoot: root, sessionId: id, pid: 9999, processStartTime: "current-start" });
  }
  for (let index = 0; index < 5; index += 1) {
    const id = `inactive-${String(index).padStart(3, "0")}`;
    startRootSession({ projectRoot: root, sessionId: id, pid: 1111, processStartTime: "old-start", now: `2020-01-01T00:0${index}:00.000Z` });
  }
  const result = cleanupRootSessions(root, {
    ...current,
    isAlive: (pid) => pid === 9999,
  });
  assert.equal(result.ok, true);
  assert.equal(result.removed, 5, "all stale inactive sessions must be pruned regardless of active count");
  assert.equal(result.remaining, 202);
  // Active sessions are never removed, even past the cap.
  assert.equal(existsSync(homeSessionManifestFile(encodeProjectId(root), "active-000")), true);
  assert.equal(existsSync(homeSessionManifestFile(encodeProjectId(root), "active-201")), true);
});

test("cleanup retains active sessions, removes oldest inactive sessions past 200, and preserves project channel state", () => {
  setup();
  const root = project();
  // Project-level channel state must not be part of session retention.
  writeChannelConfig(root, { token: "123456789:ABCDEFGHIJKLMNOPQRSTUVWX", approvedUserIds: [] });
  writeChannelRuntime(root, { lastUpdateId: 7 });
  const active = ["active-a", "active-b"];
  for (const id of active) startRootSession({ projectRoot: root, sessionId: id, pid: 9999, processStartTime: "current-start" });
  for (let index = 0; index < 205; index += 1) {
    const id = `inactive-${String(index).padStart(3, "0")}`;
    startRootSession({ projectRoot: root, sessionId: id, pid: 1111, processStartTime: "old-start", now: `2020-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z` });
  }
  const result = cleanupRootSessions(root, { currentPid: 9999, currentProcessStartTime: "current-start", isAlive: (pid) => pid === 9999 });
  assert.equal(result.ok, true);
  assert.equal(existsSync(homeSessionManifestFile(encodeProjectId(root), active[0]!)), true);
  assert.equal(existsSync(channelConfigFile(root)), true);
  assert.equal(existsSync(channelRuntimeFile(root)), true);
  assert.equal(existsSync(channelOwnerFile(root)), false);
  // Active sessions may exceed the cap, but cleanup must leave no more than 200
  // total sessions once inactive sessions are available for removal.
  const sessionRoot = homeSessionDir(encodeProjectId(root), active[0]!);
  assert.ok(sessionRoot.includes("active-a"));
});
