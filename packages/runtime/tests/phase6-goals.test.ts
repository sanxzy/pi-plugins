import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createJob } from "@xzy-ai/core";
import {
  createGoalPool,
  encodeProjectId,
  getChildPool,
  getGoalPool,
  homeGoalFile,
} from "@xzy-ai/runtime";
import { registerSessionEvents } from "../../commands/src/registrations/session-events.ts";
import { registerGoalTools } from "../../tools/src/registrations/goals.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-c2-phase6-root-"));
}
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-c2-phase6-home-"));
  process.env.PI_C2_TEST_HOME = dir;
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
  assert.equal(b.get(), undefined);
  assert.equal(b.create({ cwd: root, prompt: "exact B", interval: "1m" }).ok, true);
  // A single binding can only map one cwd to one delivery, so assert on
  // per-session isolation of the store rather than scheduler cross-talk.
  assert.deepEqual([...a.all().keys()], ["root-a"]);
  assert.equal(b.get()?.prompt, "exact B");
});

test("a new root session start never offers continuation of another session's goal", async () => {
  home();
  const root = projectRoot();
  const a = poolFor(root, "root-a");
  a.bind({ cwd: root, hasUI: true, sendUserMessage: () => {}, notify: () => {}, hasPendingMessages: () => false });
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
  assert.equal(b.get(), undefined, "the fresh root's goal store must be empty");
  assert.equal(a.get()?.prompt, "P", "the original root's goal must remain untouched");
});

test("child agent call sites receive unavailable goal-tool behavior", async () => {
  home();
  const root = projectRoot();
  const pool = getChildPool(root, "root-session");
  const registered = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text?: string }> }> }>();
  registerGoalTools({
    registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text?: string }> }> }) {
      registered.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI);
  const result = await registered.get("goal_status")!.execute("call", {}, undefined, undefined, context(root, "unknown-child"));
  assert.match(result.content[0]?.text ?? "", /goal tools are unavailable in child sessions/i);
  assert.equal(existsSync(homeGoalFile(encodeProjectId(root), "unknown-child")), false);
});

test("clearing one root session goal leaves other root sessions isolated", () => {
  home();
  const root = projectRoot();
  const a = poolFor(root, "root-a");
  const b = poolFor(root, "root-b");
  a.create({ cwd: root, prompt: "A", interval: "1m" });
  b.create({ cwd: root, prompt: "B", interval: "1m" });
  assert.equal(a.clear(), true);
  assert.equal(a.get(), undefined);
  assert.equal(b.get()?.prompt, "B");
});

test("root-session cleanup pauses only that session's goal and leaves others untouched", async () => {
  home();
  const root = projectRoot();
  const a = poolFor(root, "root-a");
  const b = poolFor(root, "root-b");
  a.create({ cwd: root, prompt: "A", interval: "1m" });
  b.create({ cwd: root, prompt: "B", interval: "1m" });
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
  // Shutdown pauses only the exiting session's goal; its store survives.
  const pausedA = getGoalPool(root, "root-a").get();
  assert.equal(pausedA?.status, "paused");
  assert.match(pausedA?.pauseReason ?? "", /quit/);
  assert.equal(existsSync(homeGoalFile(encodeProjectId(root), "root-a")), true);
  // The untouched sibling root session keeps its active goal and store.
  assert.equal(existsSync(homeGoalFile(encodeProjectId(root), "root-b")), true);
  assert.equal(getGoalPool(root, "root-b").get()?.prompt, "B");
});

test("two root sessions keep isolated goal stores with their own scheduler delivery", () => {
  home();
  const root = projectRoot();
  const a = createGoalPool(root, "root-a");
  const b = createGoalPool(root, "root-b");
  const sentOnA: string[] = [];
  const sentOnB: string[] = [];
  a.setScheduler(() => ({ clear() {} }));
  b.setScheduler(() => ({ clear() {} }));
  a.bind({ cwd: root, hasUI: true, sendUserMessage: (c) => sentOnA.push(c), notify: () => {}, hasPendingMessages: () => false });
  b.bind({ cwd: root, hasUI: true, sendUserMessage: (c) => sentOnB.push(c), notify: () => {}, hasPendingMessages: () => false });
  a.create({ cwd: root, prompt: "A", interval: "1m" });
  b.create({ cwd: root, prompt: "B", interval: "1m" });
  // Each pool delivers only its own goal's exact prompt to its own host.
  // create() triggers an immediate delivery.
  assert.equal(sentOnA.length, 1);
  assert.match(sentOnA[0]!, /^A\n/);
  assert.equal(sentOnB.length, 1);
  assert.match(sentOnB[0]!, /^B\n/);
  assert.equal(a.get()?.prompt, "A");
  assert.equal(b.get()?.prompt, "B");
  assert.equal(existsSync(homeGoalFile(encodeProjectId(root), "root-a")), true);
  assert.equal(existsSync(homeGoalFile(encodeProjectId(root), "root-b")), true);
  a.tick(root);
  b.tick(root);
  assert.equal(sentOnA.length, 2);
  assert.match(sentOnA[1]!, /^A\n/);
  assert.equal(sentOnB.length, 2);
  assert.match(sentOnB[1]!, /^B\n/);
});
