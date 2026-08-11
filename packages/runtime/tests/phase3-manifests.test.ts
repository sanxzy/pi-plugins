import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_MANIFEST_FILE_NAME,
  EVENTS_FILE_NAME,
  homeAgentDir,
  homeAgentEventsFile,
  homeAgentManifestFile,
  homeProjectManifestFile,
  homeSessionManifestFile,
  readAgentManifest,
  readProjectManifest,
  readSessionManifest,
  startRootSession,
  finishRootSession,
  createAgentManifestStore,
  foldAgentEvents,
} from "@xzy-ai/runtime";
import { canonicalProjectRoot, encodeProjectId, homeProjectDir } from "@xzy-ai/runtime";

const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function project(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-phase3-project-"));
}

function setupHome(): string {
  const home = mkdtempSync(join(tmpdir(), "pi-code-phase3-home-"));
  process.env.XZY_PI_CODE_HOME = home;
  return home;
}

test("starting and finishing a root session atomically persists private project/session manifests", () => {
  const home = setupHome();
  const root = project();
  const started = startRootSession({
    projectRoot: root,
    sessionId: "root-session",
    sessionFile: join(root, "pi-session.jsonl"),
    pid: 1234,
    processStartTime: "2026-08-11T10:00:00.000Z",
    now: "2026-08-11T10:01:00.000Z",
  });

  assert.equal(started.manifest.active, true);
  assert.equal(started.manifest.canonicalRoot, canonicalProjectRoot(root));
  assert.equal(started.manifest.pid, 1234);
  assert.equal(readProjectManifest(root).canonicalRoot, canonicalProjectRoot(root));
  assert.equal(readSessionManifest(root, "root-session").sessionId, "root-session");
  assert.equal(existsSync(homeProjectManifestFile(encodeProjectId(root))), true);
  assert.equal(mode(homeProjectDir(encodeProjectId(root))), PRIVATE_DIR);
  assert.equal(mode(homeProjectManifestFile(encodeProjectId(root))), PRIVATE_FILE);
  assert.equal(mode(homeSessionManifestFile(encodeProjectId(root), "root-session")), PRIVATE_FILE);

  const finished = finishRootSession({
    projectRoot: root,
    sessionId: "root-session",
    reason: "quit",
    now: "2026-08-11T10:05:00.000Z",
  });
  assert.equal(finished.active, false);
  assert.equal(finished.endedAt, "2026-08-11T10:05:00.000Z");
  assert.equal(readSessionManifest(root, "root-session").active, false);
});

test("relative and symlinked project aliases open the same canonical project manifest", () => {
  setupHome();
  const root = project();
  const parent = mkdtempSync(join(tmpdir(), "pi-code-phase3-alias-"));
  const alias = join(parent, "alias");
  symlinkSync(root, alias, "dir");
  const first = startRootSession({ projectRoot: root, sessionId: "root-a", now: "2026-08-11T11:00:00.000Z" });
  const second = startRootSession({ projectRoot: alias, sessionId: "root-b", now: "2026-08-11T11:01:00.000Z" });
  assert.equal(first.projectManifest.path, second.projectManifest.path);
  assert.equal(first.projectManifest.manifest.canonicalRoot, canonicalProjectRoot(root));
  assert.equal(readProjectManifest(alias).canonicalRoot, canonicalProjectRoot(root));
});

test("agent lifecycle events fold into the materialized private snapshot", () => {
  setupHome();
  const root = project();
  const store = createAgentManifestStore({
    projectRoot: root,
    rootSessionId: "root-session",
    jobId: "job-child-1",
    piSessionId: "pi-session-1",
    parentAgentIds: ["parent-1"],
    depth: 2,
    now: "2026-08-11T12:00:00.000Z",
  });

  store.create({ status: "created", description: "inspect files", subagentType: "scout" });
  store.update({ status: "queued", at: "2026-08-11T12:00:01.000Z" });
  store.update({ status: "running", at: "2026-08-11T12:00:02.000Z", startedAt: "2026-08-11T12:00:02.000Z" });
  store.update({ status: "completed", at: "2026-08-11T12:00:03.000Z", endedAt: "2026-08-11T12:00:03.000Z", delivered: true });

  const snapshot = store.read();
  const folded = foldAgentEvents(store.eventsPath);
  assert.ok(snapshot);
  assert.ok(folded);
  assert.deepEqual(snapshot, folded);
  assert.equal(snapshot.agentId, "child-1");
  assert.equal(snapshot.piSessionId, "pi-session-1");
  assert.equal(snapshot.parentAgentIds[0], "parent-1");
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.delivered, true);
  assert.equal(store.manifestPath, homeAgentManifestFile(encodeProjectId(root), "root-session", "child-1", ["parent-1"]));
  assert.equal(store.eventsPath, homeAgentEventsFile(encodeProjectId(root), "root-session", "child-1", ["parent-1"]));
  assert.equal(mode(store.agentDir), PRIVATE_DIR);
  assert.equal(mode(store.manifestPath), PRIVATE_FILE);
  assert.equal(mode(store.eventsPath), PRIVATE_FILE);
  assert.equal(readFileSync(store.eventsPath, "utf8").trim().split("\n").length, 4);
  assert.equal(existsSync(join(store.agentDir, AGENT_MANIFEST_FILE_NAME)), true);
  assert.equal(EVENTS_FILE_NAME, "events.jsonl");
});

test("corrupt project, session, and agent manifests fail closed", () => {
  setupHome();
  const root = project();
  const started = startRootSession({ projectRoot: root, sessionId: "root-session" });
  writeFileSync(started.projectManifest.path, "{broken");
  assert.throws(() => readProjectManifest(root), /Corrupt JSON manifest/);

  const sessionRoot = project();
  startRootSession({ projectRoot: sessionRoot, sessionId: "root-session-2" });
  const sessionPath = homeSessionManifestFile(encodeProjectId(sessionRoot), "root-session-2");
  writeFileSync(sessionPath, "{broken");
  assert.throws(() => readSessionManifest(sessionRoot, "root-session-2"), /Corrupt JSON manifest/);

  const agentRoot = project();
  const store = createAgentManifestStore({ projectRoot: agentRoot, rootSessionId: "root-session-3", jobId: "job-agent" });
  store.create({ status: "created", description: "x", subagentType: "x" });
  chmodSync(store.manifestPath, PRIVATE_FILE);
  writeFileSync(store.manifestPath, "{broken");
  assert.throws(() => readAgentManifest(agentRoot, "root-session-3", "job-agent"), /Corrupt JSON manifest/);
});
