import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import {
  canonicalProjectRoot,
  decodeProjectId,
  encodeProjectId,
  homeAgentDirectory,
  homeDailyErrorFile,
  homeDailyEventFile,
  homeGoalFile,
  homeProjectDir,
  homeProjectDirFromRoot,
  homeProjectsDir,
  homeRoot,
  homeRootBase,
  homeSessionDir,
  homeAgentDir,
  homeChannelConfigFile,
  homeChannelRuntimeFile,
  homeProjectManifestFile,
  homeSessionManifestFile,
  readPrivateJson,
  writePrivateJson,
} from "@xzy-ai/runtime";

const testHome = mkdtempSync(join(tmpdir(), "pi-code-home-root-"));
process.env.PI_CODE_TEST_HOME = testHome;

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-home-"));
}

function assertDirMode(dir: string, expected: number): void {
  assert.equal(statSync(dir).mode & 0o777, expected, `directory ${dir} mode`);
}

function assertFileMode(file: string, expected: number): void {
  assert.equal(statSync(file).mode & 0o777, expected, `file ${file} mode`);
}

test("project id encoding is reversible for ordinary and tricky roots", () => {
  const roots = [
    "/Users/budi/project",
    "/Users/budi/my--project [test]",
    "/a/b-c/d",
    "/Users/budi/My Project",
    "/tmp/pi-code-\u00e9t\u00e9/foo",
    "/",
    "/tmp/a\\b/c",
  ];
  for (const root of roots) {
    const id = encodeProjectId(root);
    assert.equal(decodeProjectId(id), root, `round-trip failed for ${root}`);
    assert.ok(!id.includes("/"), `project id must not contain a path separator: ${id}`);
    assert.ok(!id.includes("\\"), `project id must not contain a backslash separator: ${id}`);
  }
});

test("property: arbitrary generated components round-trip through encode/decode", async () => {
  // Deterministic PRNG so failures reproduce without external test frameworks.
  let state = 0x2f6e2b1;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const alphabet = [
    ..."abcdefghijklmnopqrstuvwxyz",
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    ..."0123456789",
    "-", "_", ".", "%", " ",
    "[", "]", "(", ")", "'", "\"", "#", "&", "+", "<", ">", "?", "!", "@", "$", "^", "*", ";", ":", ",", "/", "\\", "--",
    "é", "ü", "π", "☠", "表", "😄", "\u0000d ca",
  ];
  const randomComponent = () => {
    const length = 1 + Math.floor(next() * 12);
    let value = "";
    for (let i = 0; i < length; i++) value += alphabet[Math.floor(next() * alphabet.length)]!;
    return value;
  };
  const components: string[] = [];
  for (let i = 0; i < 400; i++) components.push(randomComponent());
  for (const component of ["a", "b--c", "c%20d", "--", "a\\b", "My Project"] ) components.push(component);
  const roots = components.map((c) => `/${c}`);
  for (const root of roots) {
    const id = encodeProjectId(root);
    // encodeProjectId internally canonicalizes (realpath/resolve), so the true
    // round-trip invariant is equality with the canonical root.
    const canonical = canonicalProjectRoot(root);
    assert.equal(decodeProjectId(id), canonical, `round-trip failed for ${JSON.stringify(root)}`);
    assert.ok(!id.includes("/"), `id must not contain /: ${id}`);
    assert.ok(!id.includes("\\"), `id must not contain backslash: ${id}`);
  }
});

test("literal `--` inside a component never collides with the component delimiter", () => {
  const a = encodeProjectId("/a/b--c");
  const b = encodeProjectId("/a/b--c/extra");
  assert.notEqual(a, b);
  assert.equal(decodeProjectId(a), "/a/b--c");
  assert.equal(decodeProjectId(b), "/a/b--c/extra");
});

test("project id is deterministic and canonical-equivalent roots share an id", () => {
  const root = projectRoot();
  const nested = join(root, "nested");
  mkdirSync(nested, { recursive: true });
  const alias = join(root, "alias");
  try {
    symlinkSync(nested, alias);
  } catch {
    // Symlink may be unavailable; at least verify determinism for a canonical root.
    assert.equal(encodeProjectId(nested), encodeProjectId(canonicalProjectRoot(nested)));
    return;
  }
  // Relative alias and symlink alias resolve to the same canonical root.
  const relativeAlias = relative(process.cwd(), nested);
  assert.equal(canonicalProjectRoot(alias), canonicalProjectRoot(nested));
  assert.equal(encodeProjectId(alias), encodeProjectId(nested));
  assert.equal(encodeProjectId(relativeAlias), encodeProjectId(nested));
});

test("home path helpers derive distinct project paths", () => {
  const root = projectRoot();
  const idA = encodeProjectId(join(root, "a"));
  const idB = encodeProjectId(join(root, "b"));
  assert.notEqual(homeProjectDir(idA), homeProjectDir(idB));
  assert.ok(homeRoot().endsWith("pi-code"));
  assert.ok(homeProjectsDir().includes("projects"));
});

test("home path helpers compose session, agent, manifest, goal, log, and channel paths", () => {
  // Use a real root so the project id is canonical and its path is usable.
  const root = projectRoot();
  const id = encodeProjectId(root);
  const project = homeProjectDir(id);
  const session = homeSessionDir(id, "root-1");
  const agent = homeAgentDir(id, "root-1", "agent-a");
  assert.equal(homeProjectManifestFile(id), join(project, "project.json"));
  assert.equal(homeSessionManifestFile(id, "root-1"), join(session, "session.json"));
  assert.ok(agent.startsWith(join(session, "agents")));
  assert.equal(homeGoalFile(id, "root-1"), join(session, "goals.jsonl"));
  assert.ok(homeDailyEventFile(id, "root-1", "2026-08-11").endsWith("events.jsonl"));
  assert.ok(homeDailyErrorFile(id, "root-1", "2026-08-11").endsWith("errors.jsonl"));
  assert.equal(homeChannelConfigFile(id), join(project, "channel.json"));
  assert.equal(homeChannelRuntimeFile(id), join(project, "channel.runtime.json"));
});

test("private directories and atomic writes enforce owner-only permissions", () => {
  const root = projectRoot();
  const id = encodeProjectId(root);
  const file = homeProjectManifestFile(id);
  writePrivateJson(file, { schemaVersion: 1, projectId: id, projectRoot: root });

  assert.equal(existsSync(file), true);
  assertDirMode(dirname(file), 0o700);
  assertFileMode(file, 0o600);

  // No temporary sibling files are left behind after an atomic write.
  const leftovers = readdirSync(dirname(file));
  assert.deepEqual(leftovers, ["project.json"]);
});

test("intermediate ancestors are repaired to owner-only, including pre-existing permissive dirs", () => {
  const base = join(testHome, "loose");
  mkdirSync(base, { recursive: true, mode: 0o755 });
  chmodSync(base, 0o755);
  const project = join(base, "deep", "project");
  const file = join(project, "project.json");
  writePrivateJson(file, { ok: true });

  // The whole home-storage subtree under the base is now private.
  assertDirMode(base, 0o700);
  assertDirMode(join(base, "deep"), 0o700);
  assertDirMode(project, 0o700);
  assertFileMode(file, 0o600);
});

test("atomic write replaces prior value and readPrivateJson returns the new value", () => {
  const root = projectRoot();
  const id = encodeProjectId(root);
  const file = homeProjectManifestFile(id);
  writePrivateJson(file, { schemaVersion: 1, projectId: id, projectRoot: root, label: "first" });
  assert.deepEqual(readPrivateJson(file), { schemaVersion: 1, projectId: id, projectRoot: root, label: "first" });

  // A second write replaces the file atomically and is fully readable (no partial state).
  writePrivateJson(file, { schemaVersion: 1, projectId: id, projectRoot: root, label: "second", count: 2 });
  assert.deepEqual(readPrivateJson<{ count: number }>(file), { schemaVersion: 1, projectId: id, projectRoot: root, label: "second", count: 2 });
});

test("corrupt manifest fails closed when read", () => {
  const root = projectRoot();
  const id = encodeProjectId(root);
  const file = homeProjectManifestFile(id);
  writePrivateJson(file, { schemaVersion: 1, projectId: id, projectRoot: root });
  writeFileSync(file, "{ broken", "utf8");

  // Fails closed with a descriptive error rather than silently returning data.
  assert.throws(() => readPrivateJson(file), /Corrupt JSON manifest/);
  // The corrupt content is preserved untouched (no repair/overwrite).
  assert.equal(readFileSync(file, "utf8"), "{ broken");
});

test("home agent directory resolves a configured tilde override", () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const previousHome = process.env.PI_CODE_TEST_HOME;
  try {
    process.env.PI_CODE_TEST_HOME = "~/xzy/home";
    assert.ok(homeRootBase().endsWith(join("xzy", "home")));
    assert.ok(!homeRootBase().includes("~"), "tilde must be expanded, not literal");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    if (previousHome === undefined) delete process.env.PI_CODE_TEST_HOME;
    else process.env.PI_CODE_TEST_HOME = previousHome;
  }
});