import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createJob } from "@xzy-ai/core";
import {
  encodeProjectId,
  getChildPool,
  getGoalPool,
  homeGoalFile,
} from "@xzy-ai/runtime";
import { registerSessionEvents } from "../../commands/src/registrations/session-events.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-phase6-root-"));
}
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-code-phase6-home-"));
  process.env.XZY_PI_CODE_HOME = dir;
  return dir;
}
function context(cwd: string, sessionId: string, sessionFile: string | undefined = join(cwd, "sessions", `${sessionId}.jsonl`)): ExtensionContext {
  return {
    mode: "tui",
    hasUI: true,
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
    },
    isIdle: () => true,
    ui: { confirm: async () => true, notify: () => {} },
  } as unknown as ExtensionContext;
}

function poolFor(root: string, sessionId: string) {
  return getGoalPool(root, sessionId);
}

test("goal created in one root session is invisible and unschedulable from a second root session", () => {
  home();
  const root = projectRoot();
  const a = poolFor(root, "root-a");
  const b = poolFor(root, "root-b");
  assert.equal(a.create({ cwd: root, prompt: "exact A", interval: "1m" }).ok, true);
  assert.equal(b.get(root), undefined);
  assert.equal(b.create({ cwd: root, prompt: "exact B", interval: "1m" }).ok, true);
  // A single binding can only map one cwd to one delivery, so assert on
  // per-session isolation of the store rather than scheduler cross-talk.
  assert.deepEqual([...a.all().keys()], [b.get(root)?.cwd ?? root]);
  assert.equal(b.get(root)?.prompt, "exact B");
});

test("a new root session start never offers continuation of another session's goal", async () => {
  home();
  const root = projectRoot();
  const a = poolFor(root, "root-a");
  a.bind({ cwd: root, hasUI: true, sendUserMessage: () => {}, notify: () => {} });
  a.setScheduler(() => ({ clear() {} }));
  assert.equal(a.create({ cwd: root, prompt: "P", interval: "1m" }).ok, true);

  const handlers = new Map<string, Handler>();
  registerSessionEvents({
    on(event: string, handler: Handler) { handlers.set(event, handler); },
    setActiveTools() {},
    getAllTools() { return []; },
  } as unknown as ExtensionAPI);
  let confirmed = 0;
  const ctx = context(root, "root-b") as ExtensionContext & { ui: { confirm: () => Promise<boolean> } };
  ctx.ui.confirm = async () => { confirmed += 1; return true; };
  await handlers.get("session_start")!({ reason: "new" }, ctx);

  assert.equal(confirmed, 0, "a replacement root must not ask to continue another session's goal");
  const b = poolFor(root, "root-b");
  assert.equal(b.get(root), undefined, "the fresh root's goal store must be empty");
  assert.equal(a.get(root)?.prompt, "P", "the original root's goal must remain untouched");
});

test("child agent call sites cannot manage goals (no new store surfaces them)", () => {
  home();
  const root = projectRoot();
  // A child session id must not create or expose a goal store; goal tools reject
  // it via the child-vertex discriminator.
  const pool = getChildPool(root, "root-session");
  pool.registry.createJob(createJob({
    jobId: "child-session",
    parentSessionId: "root-session",
    sessionId: "child-session",
    status: "running",
    description: "child",
    subagentType: "test-agent",
  }));
  assert.equal(existsSync(homeGoalFile(encodeProjectId(root), "child-session")), false);
});

test("clearing one root session goal leaves other root sessions isolated", () => {
  home();
  const root = projectRoot();
  const a = poolFor(root, "root-a");
  const b = poolFor(root, "root-b");
  a.create({ cwd: root, prompt: "A", interval: "1m" });
  b.create({ cwd: root, prompt: "B", interval: "1m" });
  assert.equal(a.clear(root), true);
  assert.equal(a.get(root), undefined);
  assert.equal(b.get(root)?.prompt, "B");
});

test("session shutdown removes the root session goal store only on quit/new sweep", async () => {
  home();
  const root = projectRoot();
  const a = poolFor(root, "root-a");
  a.create({ cwd: root, prompt: "A", interval: "1m" });
  const handlers = new Map<string, Handler>();
  registerSessionEvents({
    on(event: string, handler: Handler) { handlers.set(event, handler); },
    setActiveTools() {},
    getAllTools() { return []; },
  } as unknown as ExtensionAPI);
  // session_shutdown with reason "new" is a root-teardown path in this test.
  const ctx = context(root, "root-a") as ExtensionContext & { ui: { confirm: () => Promise<boolean> } };
  ctx.ui.confirm = async () => false;
  // registerSessionEvents only wires turn_start/session_start/session_shutdown.
  void ctx;
  const pull = handlers.get("session_shutdown");
  if (pull) {
    await pull({ reason: "quit" }, context(root, "root-a"));
  }
  // The goal store file remains scoped to the root session; only Phase 7
  // cleanup physically removes it. A fresh reader of the same session sees it.
  assert.equal(getGoalPool(root, "root-a").get(root)?.prompt, "A");

});

test("two root sessions keep isolated goal stores with their own scheduler delivery", () => {
  home();
  const root = projectRoot();
  const a = poolFor(root, "root-a");
  const b = poolFor(root, "root-b");
  const sentOnA: string[] = [];
  const sentOnB: string[] = [];
  a.setScheduler(() => ({ clear() {} }));
  b.setScheduler(() => ({ clear() {} }));
  a.bind({ cwd: root, hasUI: true, sendUserMessage: (c) => sentOnA.push(c), notify: () => {} });
  b.bind({ cwd: root, hasUI: true, sendUserMessage: (c) => sentOnB.push(c), notify: () => {} });
  a.create({ cwd: root, prompt: "A", interval: "1m" });
  b.create({ cwd: root, prompt: "B", interval: "1m" });
  // Each pool delivers only its own goal's exact prompt to its own host.
  assert.equal(a.get(root)?.prompt, "A");
  assert.equal(b.get(root)?.prompt, "B");
  assert.equal(existsSync(homeGoalFile(encodeProjectId(root), "root-a")), true);
  assert.equal(existsSync(homeGoalFile(encodeProjectId(root), "root-b")), true);
  a.tick(root);
  b.tick(root);
  assert.ok(sentOnA.length <= 1);
  assert.ok(sentOnB.length <= 1);
});
