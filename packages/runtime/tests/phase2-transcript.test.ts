import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  childSessionPaths,
  createChildSessionManager,
  encodeProjectId,
  homeAgentDir,
  homeAgentTranscriptFile,
  homeProjectDir,
  prepareResumeSessionFile,
} from "@xzy-ai/runtime";

const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;
const testHome = mkdtempSync(join(tmpdir(), "pi-code-phase2-home-"));
process.env.PI_CODE_TEST_HOME = testHome;

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function flushTranscript(manager: SessionManager): void {
  manager.appendMessage({
    role: "assistant",
    content: [],
    timestamp: Date.now(),
    stopReason: "stop",
  } as never);
}

test("production child storage paths use the home project and nested agent layout", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-phase2-paths-"));
  const paths = childSessionPaths({
    cwd: root,
    rootSessionId: "root-1",
    jobId: "child-2",
    parentAgentIds: ["parent-1"],
  });
  const expectedDir = homeAgentDir(encodeProjectId(root), "root-1", "child-2", ["parent-1"]);
  assert.equal(paths.projectDir, homeProjectDir(encodeProjectId(root)));
  assert.equal(paths.agentDir, expectedDir);
  assert.equal(paths.transcriptFile, homeAgentTranscriptFile(encodeProjectId(root), "root-1", "child-2", ["parent-1"]));
  assert.equal(paths.transcriptFile, join(expectedDir, "transcript.jsonl"));
});

test("resume copy writes the new agent transcript directly with private permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-phase2-resume-"));
  const sourceDir = join(root, "source");
  const source = join(sourceDir, "transcript.jsonl");
  const sourceManager = SessionManager.create(root, sourceDir, { id: "source-1", parentSession: "root-1", sessionFilename: "transcript.jsonl" });
  flushTranscript(sourceManager);
  // Copy the source to a new canonical agent identity under the home layout.
  const destination = prepareResumeSessionFile(source, "resumed-1", root, "root-1", "root-1", ["parent-1"]);
  const expected = homeAgentTranscriptFile(encodeProjectId(root), "root-1", "resumed-1", ["parent-1"]);
  assert.equal(destination, expected);
  assert.equal(readFileSync(destination, "utf8").includes('"id":"resumed-1"'), true);
  assert.equal(mode(destination), PRIVATE_FILE);
  assert.equal(mode(homeAgentDir(encodeProjectId(root), "root-1", "resumed-1", ["parent-1"])), PRIVATE_DIR);
});

test("production child-session manager creates and resumes the home transcript", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-phase2-adapter-"));
  const context = { cwd: root, rootSessionId: "root-1", parentSessionId: "root-1", parentAgentIds: ["parent-1"] };
  const fresh = createChildSessionManager({ ...context, jobId: "fresh-1" });
  flushTranscript(fresh);
  const expectedFresh = homeAgentTranscriptFile(encodeProjectId(root), "root-1", "fresh-1", ["parent-1"]);
  assert.equal(fresh.getSessionFile(), expectedFresh);
  assert.equal(mode(expectedFresh), PRIVATE_FILE);

  const resumedPath = prepareResumeSessionFile(expectedFresh, "resumed-1", root, "root-1", "root-1", ["parent-1"]);
  const resumed = createChildSessionManager({ ...context, jobId: "resumed-1", sessionFile: resumedPath });
  assert.equal(resumed.getSessionFile(), resumedPath);
  assert.equal(mode(resumed.getSessionFile()!), PRIVATE_FILE);
  assert.equal(mode(join(testHome, "pi-code")), PRIVATE_DIR);
});

test("fresh SDK child session uses deterministic transcript.jsonl with private permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-phase2-"));
  const agentDir = join(root, "agent");
  const manager = SessionManager.create(root, agentDir, { id: "agent-1", parentSession: "root-1", sessionFilename: "transcript.jsonl" });
  flushTranscript(manager);

  assert.equal(manager.getSessionFile(), join(agentDir, "transcript.jsonl"));
  assert.equal(existsSync(manager.getSessionFile()!), true);
  assert.equal(mode(agentDir), PRIVATE_DIR);
  assert.equal(mode(manager.getSessionFile()!), PRIVATE_FILE);
  assert.deepEqual(readdirSync(agentDir), ["transcript.jsonl"]);
});

test("reopening and reflushing a child transcript preserves its deterministic path and modes", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-phase2-reopen-"));
  const agentDir = join(root, "agent");
  const first = SessionManager.create(root, agentDir, { id: "agent-2", parentSession: "root-1", sessionFilename: "transcript.jsonl" });
  flushTranscript(first);
  const file = first.getSessionFile()!;
  const reopened = SessionManager.open(file, agentDir);

  assert.equal(reopened.getSessionFile(), file);
  assert.equal(mode(agentDir), PRIVATE_DIR);
  assert.equal(mode(file), PRIVATE_FILE);

  // A session rewrite/flush must not loosen permissions or create a second file.
  reopened.appendCustomEntry("phase2-test", { ok: true });
  assert.equal(mode(agentDir), PRIVATE_DIR);
  assert.equal(mode(file), PRIVATE_FILE);
  assert.deepEqual(readdirSync(agentDir), ["transcript.jsonl"]);
});

test("reopening an existing permissive transcript repairs its directory and file modes", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-phase2-repair-"));
  const agentDir = join(root, "agent");
  const first = SessionManager.create(root, agentDir, { id: "agent-3", parentSession: "root-1", sessionFilename: "transcript.jsonl" });
  flushTranscript(first);
  const file = first.getSessionFile()!;

  chmodSync(agentDir, 0o755);
  chmodSync(file, 0o644);
  const reopened = SessionManager.open(file, agentDir);

  assert.equal(reopened.getSessionFile(), join(agentDir, "transcript.jsonl"));
  assert.equal(mode(agentDir), PRIVATE_DIR);
  assert.equal(mode(file), PRIVATE_FILE);
});

test("SDK repairs permissive existing ancestors up to the project boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-phase2-ancestors-"));
  const paths = childSessionPaths({ cwd: root, rootSessionId: "root-1", jobId: "agent-4" });
  mkdirSync(paths.agentDir, { recursive: true, mode: 0o755 });
  for (let current = paths.agentDir; ; current = dirname(current)) {
    chmodSync(current, 0o755);
    if (current === paths.projectDir) break;
  }

  const manager = SessionManager.create(root, paths.agentDir, {
    id: "agent-4",
    parentSession: "root-1",
    sessionFilename: "transcript.jsonl",
    privateRoot: paths.projectDir,
  });
  flushTranscript(manager);

  for (let current = paths.agentDir; ; current = dirname(current)) {
    assert.equal(mode(current), PRIVATE_DIR, `ancestor ${current} must be private`);
    if (current === paths.projectDir) break;
  }
  assert.equal(mode(manager.getSessionFile()!), PRIVATE_FILE);
});

test("nested agent directories remain private when created through SDK sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-phase2-nested-"));
  const parentDir = join(root, "parent", "agents", "parent-1");
  const childDir = join(parentDir, "agents", "child-1");
  const manager = SessionManager.create(root, childDir, { id: "child-1", parentSession: "parent-1", sessionFilename: "transcript.jsonl" });
  flushTranscript(manager);

  assert.equal(manager.getSessionFile(), join(childDir, "transcript.jsonl"));
  assert.equal(mode(root), PRIVATE_DIR);
  assert.equal(mode(join(root, "parent")), PRIVATE_DIR);
  assert.equal(mode(join(root, "parent", "agents")), PRIVATE_DIR);
  assert.equal(mode(parentDir), PRIVATE_DIR);
  assert.equal(mode(join(parentDir, "agents")), PRIVATE_DIR);
  assert.equal(mode(childDir), PRIVATE_DIR);
  assert.equal(mode(manager.getSessionFile()!), PRIVATE_FILE);
});
