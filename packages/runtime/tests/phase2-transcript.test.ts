import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;

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
