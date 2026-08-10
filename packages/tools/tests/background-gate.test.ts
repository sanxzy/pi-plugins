import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_CONCURRENCY } from "@xzy-ai/core";
import { getChildPool, spawnChildSession } from "@xzy-ai/runtime";
import { registerAgentTool } from "../src/registrations/agent.ts";

/**
 * Composition-root regression test for queued background lifecycle.
 *
 * This drives the real agent tool registration with a saturated shared gate and
 * an injected child-session adapter. A waiting background job must remain
 * queued until gate admission; admission then publishes the live handle and
 * changes the registry state to running.
 */

type RegisteredAgent = {
  execute: (
    toolCallId: string,
    params: {
      description: string;
      prompt: string;
      subagent_type: string;
      background?: boolean;
    },
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ) => Promise<{ content: Array<{ text: string }>; details: { jobId: string; status?: string } }>;
};

function context(cwd: string, mode: string = "tui"): ExtensionContext {
  return {
    mode,
    hasUI: true,
    cwd,
    model: {} as ExtensionContext["model"],
    ui: {
      custom: async () => undefined,
      getEditorText: () => "",
      setEditorText: () => {},
    },
    sessionManager: {
      getSessionId: () => "root-session",
      getSessionFile: () => join(cwd, "sessions", "root-session.jsonl"),
    },
  } as unknown as ExtensionContext;
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("agent schema removes the redundant background parameter", () => {
  let registered: { parameters: { properties?: Record<string, unknown> } } | undefined;
  registerAgentTool({
    registerTool(tool: typeof registered) {
      registered = tool;
    },
  } as unknown as ExtensionAPI);
  assert.ok(registered);
  assert.equal(registered.parameters.properties?.background, undefined);
});

test("new background spawns remain TUI-only", async () => {
  let registered: RegisteredAgent | undefined;
  registerAgentTool({
    registerTool(tool: RegisteredAgent) {
      registered = tool;
    },
  } as unknown as ExtensionAPI);
  assert.ok(registered);
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-background-mode-"));
  try {
    const result = await registered.execute(
      "call",
      { description: "print", prompt: "work", subagent_type: "test-agent" },
      undefined,
      undefined,
      context(cwd, "print"),
    );
    assert.equal(result.content[0]?.text, "Error: background agents are available only in TUI mode");
    assert.deepEqual(result.details, { jobId: undefined, reason: "background mode is invalid in print mode" });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a gated background agent stays queued until running with a live handle", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-background-gate-"));
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "agents", "test-agent.md"),
    "---\nname: test-agent\ndescription: Test agent\n---\ntest body",
    "utf8",
  );
  const pool = getChildPool(cwd, "root-session");
  const held = Array.from({ length: MAX_CONCURRENCY }, () => deferred<void>());
  const holdRuns = held.map((slot) => pool.concurrency.run(async () => slot.promise));
  await flush();
  assert.equal(pool.concurrency.activeCount, MAX_CONCURRENCY);

  let promptRelease: (() => void) | undefined;
  let promptStarted!: () => void;
  const promptReady = new Promise<void>((resolve) => {
    promptStarted = resolve;
  });
  const listeners = new Set<(event: unknown) => void>();
  const fakeMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    timestamp: 1,
    stopReason: "stop",
  };
  const fakeSession = {
    sessionFile: join(cwd, "sessions", "child.jsonl"),
    isStreaming: false as boolean,
    agent: { state: { messages: [] as unknown[] } },
    subscribe(listener: (event: unknown) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      promptStarted();
      await new Promise<void>((resolve) => {
        promptRelease = resolve;
      });
      fakeSession.isStreaming = false;
      fakeSession.agent.state.messages.push(fakeMessage);
      for (const listener of [...listeners]) {
        listener({ type: "message_start", message: { ...fakeMessage } });
        listener({ type: "message_end", message: { ...fakeMessage } });
        listener({ type: "agent_settled" });
      }
    },
    async steer() {},
    async abort() {},
    getLastAssistantText() {
      return "done";
    },
    dispose() {},
  };
  const previousFactory = spawnChildSession.__createChild;
  spawnChildSession.__createChild = async () => ({
    session: fakeSession as never,
    dispose: () => fakeSession.dispose(),
  });

  let registered: RegisteredAgent | undefined;
  const pi = {
    registerTool(tool: RegisteredAgent) {
      registered = tool;
    },
  } as unknown as ExtensionAPI;
  registerAgentTool(pi);

  try {
    assert.ok(registered);
    const result = await registered.execute(
      "call-1",
      { description: "wait for capacity", prompt: "work", subagent_type: "test-agent" },
      undefined,
      undefined,
      context(cwd),
    );
    const jobId = result.details.jobId;
    assert.equal(pool.registry.get(jobId)?.status, "queued");
    assert.equal(pool.liveChildren.has(jobId), false);
    assert.equal(result.details.status, "queued");
    assert.match(result.content[0]?.text ?? "", /Accepted background agent test-agent/);

    // Free one gate slot. The queued background operation is admitted, marks
    // running in spawnWithControl, and publishes its live control.
    held[0]!.resolve();
    await promptReady;
    assert.equal(pool.registry.get(jobId)?.status, "running");
    assert.equal(pool.liveChildren.has(jobId), true);

    promptRelease!();
    await flush();
    assert.equal(pool.registry.get(jobId)?.status, "completed");
    assert.equal(pool.liveChildren.has(jobId), false);
  } finally {
    spawnChildSession.__createChild = previousFactory;
    // Release every held slot so no gate waiter is left dangling.
    for (const slot of held) slot.resolve();
    await Promise.allSettled(holdRuns);
    await flush();
    rmSync(cwd, { recursive: true, force: true });
  }
});
