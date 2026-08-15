import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { encodeProjectId, getGoalPool, homeGoalFile, normalizeGoalCwd } from "@xzy-ai/runtime";

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-c2-goal-store-"));
}

test("goal pool enforces the project-scoped centralized prompt-length setting", () => {
  const root = projectRoot();
  const configRoot = mkdtempSync(join(tmpdir(), "pi-c2-goal-settings-home-"));
  process.env.PI_C2_TEST_HOME = configRoot;
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi", "pi-c2.json"), JSON.stringify({ commands: { goalMaxPromptLength: 5 } }));
  try {
    const pool = getGoalPool(root);
    assert.equal(pool.create({ cwd: root, prompt: "12345" }).ok, true);
    pool.clear(root);
    assert.equal(pool.create({ cwd: root, prompt: "123456" }).ok, false);
  } finally {
    delete process.env.PI_C2_TEST_HOME;
    rmSync(configRoot, { recursive: true, force: true });
  }
});

test("nested goal cwd uses the pool project prompt-length setting", () => {
  const root = projectRoot();
  const nested = join(root, "nested");
  mkdirSync(join(root, ".pi"), { recursive: true });
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(root, ".pi", "pi-c2.json"), JSON.stringify({ commands: { goalMaxPromptLength: 5 } }));
  const pool = getGoalPool(root);
  assert.equal(pool.create({ cwd: nested, prompt: "12345" }).ok, true);
  pool.clear(nested);
  assert.equal(pool.create({ cwd: nested, prompt: "123456" }).ok, false);
});

test("an invalid centralized prompt-length setting falls through to the safe default", () => {
  const root = projectRoot();
  const configRoot = mkdtempSync(join(tmpdir(), "pi-c2-goal-bad-settings-home-"));
  process.env.PI_C2_TEST_HOME = configRoot;
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi", "pi-c2.json"), JSON.stringify({ commands: { goalMaxPromptLength: 0 } }));
  try {
    const pool = getGoalPool(root);
    assert.equal(pool.create({ cwd: root, prompt: "x".repeat(4_001) }).ok, false, "a zero/invalid bound never widens the cap");
  } finally {
    delete process.env.PI_C2_TEST_HOME;
    rmSync(configRoot, { recursive: true, force: true });
  }
});

test("goal store persists a flat record and survives a fresh reader", () => {
  const root = projectRoot();
  const store = getGoalPool(root);
  store.create({ cwd: "/project", prompt: "  exact  ", intervalMs: 30_000 });
  const first = store.get("/project");
  assert.ok(first);
  assert.equal(first.prompt, "  exact  ");
  assert.equal(first.status, "active");

  const fresh = getGoalPool(root);
  const folded = fresh.get("/project");
  assert.equal(folded?.prompt, "  exact  ");
  assert.equal(folded?.status, "active");
});

test("goal store rejects a second goal for an existing cwd and requires clearing", () => {
  const root = projectRoot();
  const store = getGoalPool(root);
  store.create({ cwd: "/a", prompt: "first", intervalMs: 10_000 });
  assert.equal(store.create({ cwd: "/a", prompt: "second", intervalMs: 10_000 }).ok, false);
  assert.equal(store.get("/a")?.prompt, "first");
  store.clear("/a");
  assert.equal(store.create({ cwd: "/a", prompt: "second", intervalMs: 10_000 }).ok, true);
  assert.equal(store.get("/a")?.prompt, "second");
});

test("goal store pauses with exact reason, resumes, and clears reason", () => {
  const root = projectRoot();
  const store = getGoalPool(root);
  store.create({ cwd: "/a", prompt: "p", intervalMs: 10_000 });
  const paused = store.pause("/a", "waiting for review");
  assert.ok(paused.ok);
  assert.equal(paused.goal.status, "paused");
  assert.equal(paused.goal.pauseReason, "waiting for review");
  const resumed = store.resume("/a");
  assert.ok(resumed.ok);
  assert.equal(resumed.goal.status, "active");
  assert.equal(resumed.goal.pauseReason, undefined);
});

test("goal store tolerates malformed log lines and isolates multiple cwd records", () => {
  const root = projectRoot();
  const store = getGoalPool(root);
  store.create({ cwd: "/a", prompt: "A", intervalMs: 10_000 });
  store.create({ cwd: "/b", prompt: "B", intervalMs: 20_000 });
  appendFileSync(homeGoalFile(encodeProjectId(root), "root"), "{not json}\n{\"event\":\"goal_created\"}\n");
  const fresh = getGoalPool(root);
  assert.equal(fresh.get("/a")?.prompt, "A");
  assert.equal(fresh.get("/b")?.prompt, "B");
  assert.equal(fresh.all().size, 2);
});

test("goal pool normalizes cwd and rejects invalid lifecycle mutations without persistence", () => {
  const root = projectRoot();
  const pool = getGoalPool(root);
  const created = pool.create({ cwd: root, prompt: "goal", interval: "1m" });
  assert.equal(created.ok, true);
  assert.equal(pool.get(root)?.cwd, normalizeGoalCwd(root));
  const emptyReason = pool.pause(root, "   ");
  assert.equal(emptyReason.ok, false);
  const missing = pool.pause(join(root, "missing"), "reason");
  assert.equal(missing.ok, false);
  assert.equal(pool.get(root)?.status, "active");
});

test("goal pool keeps separate cwd records isolated during mutation", () => {
  const root = projectRoot();
  const pool = getGoalPool(root);
  assert.equal(pool.create({ cwd: join(root, "a"), prompt: "A", interval: "1m" }).ok, true);
  assert.equal(pool.create({ cwd: join(root, "b"), prompt: "B", interval: "2m" }).ok, true);
  assert.equal(pool.pause(join(root, "a"), "only A").ok, true);
  assert.equal(pool.get(join(root, "a"))?.status, "paused");
  assert.equal(pool.get(join(root, "b"))?.status, "active");
});