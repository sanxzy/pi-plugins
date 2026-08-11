import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  finishRootSession,
  homeSessionDir,
  homeSessionManifestFile,
  encodeProjectId,
  readSessionManifest,
  startRootSession,
} from "@xzy-ai/runtime";
import {
  channelConfigFile,
  channelLogFile,
  channelOwnerFile,
  channelRuntimeFile,
} from "@xzy-ai/channels";

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-code-phase7-home-"));
  process.env.XZY_PI_CODE_HOME = dir;
  return dir;
}
function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-phase7-proj-"));
}

test("channel state (config, runtime, owner) stays project-owned under home storage", () => {
  home();
  const proj = projectRoot();
  const projectId = encodeProjectId(proj);
  const cfg = channelConfigFile(proj);
  const runtime = channelRuntimeFile(proj);
  const owner = channelOwnerFile(proj);
  // All three are single project-owned files under the home project dir, not
  // under any root session directory.
  assert.equal(cfg.includes("/.pi/"), false, "config must move to home storage");
  assert.equal(runtime.endsWith("channel.runtime.json"), true);
  assert.equal(owner.endsWith("channel.owner.json"), true);
  assert.ok(cfg.includes("/sessions/") === false, "config must stay project-owned, not session-owned");
});

test("channel activity log is scoped to the active root session under home storage", () => {
  home();
  const proj = projectRoot();
  // Session-scoped channel log lives under a root-session-scoped path, not the
  // project-local .pi tree.
  const log = channelLogFile(proj, "root-a");
  assert.equal(log.includes("/.pi/"), false, "channel log must move to home storage");
});

test("root-session cleanup removes the full session directory (goals, logs, agents, manifests)", () => {
  home();
  const proj = projectRoot();
  const projectId = encodeProjectId(proj);
  startRootSession({ projectRoot: proj, sessionId: "root-a", pid: 1111, processStartTime: "2026-01-01T00:00:00.000Z" });
  const sessionDir = homeSessionDir(projectId, "root-a");
  mkdirSync(join(sessionDir, "goals"), { recursive: true });
  writeFileSync(join(sessionDir, "goals.jsonl"), "{}\n", "utf8");
  assert.equal(existsSync(homeSessionManifestFile(projectId, "root-a")), true);

  finishRootSession({ projectRoot: proj, sessionId: "root-a" });
  const manifest = readSessionManifest(proj, "root-a");
  assert.equal(manifest.active, false);
  assert.equal(readSessionManifest(proj, "root-a").active, false);
});
