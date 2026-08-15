import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearMcpNames, createJob, publishSessionMcpActive } from "@xzy-ai/core";
import { getChildPool } from "@xzy-ai/runtime";
import {
  markSessionReload,
  registerSessionEvents,
  takeSessionReload,
  clearSessionReload,
} from "../src/registrations/session-events.ts";
import { createHostMessageGate } from "../src/registrations/safe-host-delivery.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-c2-session-events-"));
}

function context(cwd: string, sessionId: string): ExtensionContext {
  return {
    mode: "tui",
    hasUI: true,
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => join(cwd, "sessions", `${sessionId}.jsonl`),
    },
  } as unknown as ExtensionContext;
}

function registrations(): { pi: ExtensionAPI; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    pi: {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI,
  };
}

function registrationsWithSteer(): { pi: ExtensionAPI; handlers: Map<string, Handler>; steers: string[] } {
  const handlers = new Map<string, Handler>();
  const steers: string[] = [];
  return {
    steers,
    handlers,
    pi: {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      sendUserMessage(content: string | { type: string; text: string }[], options?: { deliverAs?: string }) {
        const text = typeof content === "string" ? content : content.map((p) => p.text).join("");
        steers.push(text);
      },
      setActiveTools() {},
      getAllTools() {
        return [];
      },
    } as unknown as ExtensionAPI,
  };
}

test("a reload marker makes the fresh root session_start steer the model", async () => {
  const cwd = projectRoot();
  try {
    markSessionReload(cwd);
    const { pi, handlers, steers } = registrationsWithSteer();
    registerSessionEvents(pi);
    await handlers.get("session_start")!({ reason: "reload" }, context(cwd, "root-a"));
    assert.deepEqual(steers, ["Your session was reloaded."]);
    assert.equal(takeSessionReload(cwd), false, "the marker must be consumed by session_start");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("startup does not reactivate MCP resource tools when the session surface is inactive", async () => {
  const cwd = projectRoot();
  try {
    const activeSnapshots: string[][] = [];
    const handlers = new Map<string, Handler>();
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      sendUserMessage() {},
      setActiveTools(names: string[]) {
        activeSnapshots.push(names);
      },
      getAllTools() {
        return [
          { name: "read" },
          { name: "mcp_resources_list" },
          { name: "mcp_resources_read" },
        ];
      },
    } as unknown as ExtensionAPI;
    const ctx = context(cwd, "root-a");
    publishSessionMcpActive(ctx, false);
    registerSessionEvents(pi);
    await handlers.get("session_start")!({ reason: "startup" }, ctx);
    assert.deepEqual(activeSnapshots.at(-1), ["read"]);
  } finally {
    clearMcpNames(context(cwd, "root-a"));
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a startup without a marker does not steer the model", async () => {
  const cwd = projectRoot();
  try {
    const { pi, handlers, steers } = registrationsWithSteer();
    registerSessionEvents(pi);
    await handlers.get("session_start")!({ reason: "startup" }, context(cwd, "root-a"));
    assert.deepEqual(steers, []);
    assert.equal(takeSessionReload(cwd), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the marker is consumed once across repeated session_start events", async () => {
  const cwd = projectRoot();
  try {
    markSessionReload(cwd);
    const { pi, handlers, steers } = registrationsWithSteer();
    registerSessionEvents(pi);
    await handlers.get("session_start")!({ reason: "reload" }, context(cwd, "root-a"));
    await handlers.get("session_start")!({ reason: "reload" }, context(cwd, "root-a"));
    assert.deepEqual(steers, ["Your session was reloaded."]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("child sessions never consume the reload marker", async () => {
  const cwd = projectRoot();
  try {
    const pool = getChildPool(cwd, "root-a");
    pool.registry.createJob(createJob({
      jobId: "child-1",
      parentSessionId: "root-a",
      parentJobId: undefined,
      rootJobId: "child-1",
      depth: 0,
      sessionId: "child-1",
      status: "running",
      description: "child",
      subagentType: "test-agent",
    }));
    markSessionReload(cwd);
    const { pi, handlers, steers } = registrationsWithSteer();
    registerSessionEvents(pi);
    await handlers.get("session_start")!({ reason: "reload" }, context(cwd, "child-1"));
    assert.deepEqual(steers, [], "child session must not steer on the parent's reload marker");
    assert.equal(takeSessionReload(cwd), true, "the marker stays for the root session");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("clearSessionReload drops a pending marker", async () => {
  const cwd = projectRoot();
  try {
    markSessionReload(cwd);
    clearSessionReload(cwd);
    assert.equal(takeSessionReload(cwd), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("reload steer is deferred while the host agent is mid-run and sent on agent_end", async () => {
  const cwd = projectRoot();
  try {
    markSessionReload(cwd);
    let idle = false;
    const { pi, handlers, steers } = registrationsWithSteer();
    const ctx = {
      ...context(cwd, "root-a"),
      isIdle: () => idle,
      hasPendingMessages: () => false,
    } as unknown as ExtensionContext;
    registerSessionEvents(pi);
    await handlers.get("session_start")!({ reason: "reload" }, ctx);
    // pi prints "Agent is already processing a prompt" when a new prompt is
    // started while a run is in flight, so the reload notice must wait.
    assert.deepEqual(steers, [], "a busy host must not receive the reload steer");

    // The in-flight run settles: the gate drains its queue only once the run
    // has fully settled (agent_end then agent_settled), so the notice can
    // never race a still-finishing prompt.
    idle = true;
    await handlers.get("agent_end")!({ messages: [] });
    await handlers.get("agent_settled")!({});
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(steers, ["Your session was reloaded."]);
    assert.equal(takeSessionReload(cwd), false, "the marker was consumed by session_start");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("delivery sink defers results while the host agent is busy", async () => {
  const cwd = projectRoot();
  try {
    let idle = false;
    const { pi, handlers, steers } = registrationsWithSteer();
    const ctx = {
      ...context(cwd, "root-a"),
      isIdle: () => idle,
      hasPendingMessages: () => false,
    } as unknown as ExtensionContext;
    registerSessionEvents(pi);
    await handlers.get("session_start")!({ reason: "startup" }, ctx);
    const sessionFile = join(cwd, "sessions", "root-a.jsonl");

    // A background result arrives while the host is mid-run: the sink must
    // reject so the coordinator keeps it durable pending instead of calling
    // pi.sendUserMessage into an active prompt.
    const sent = getChildPool(cwd, "root-a").deliveryFor("root-a").deliverResult("job-a", sessionFile, "result-a");
    assert.equal(sent, false);
    assert.deepEqual(steers, [], "the busy host must not be prompted");

    // Once idle, the sink accepts the result on the coordinator's retry.
    idle = true;
    const pool = getChildPool(cwd, "root-a");
    const coordinator = pool.deliveryFor("root-a");
    assert.equal(coordinator.pendingCount, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a disposed host gate drops queued messages, cancels retries, and rejects new sends", async () => {
  let idle = false;
  const steers: string[] = [];
  const pi = {
    on() {},
    sendUserMessage(content: string) {
      steers.push(content);
    },
  } as unknown as ExtensionAPI;
  const ctx = { isIdle: () => idle, hasPendingMessages: () => false } as unknown as ExtensionContext;
  const gate = createHostMessageGate(pi, ctx);
  gate.send("queued-while-busy");
  assert.deepEqual(steers, [], "the busy host must not be prompted");

  // A session replacement disposes the gate: queued work is dropped, the retry
  // timer is cancelled, and the disposed gate never sends again.
  gate.dispose();
  idle = true;
  gate.send("after-dispose");
  assert.equal(gate.trySend("try-after-dispose"), false);
  assert.equal(gate.ready(), false);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(steers, [], "a disposed gate must never deliver");
});

test("an active turn blocks host delivery even when the runner misreports idle", async () => {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const steers: string[] = [];
  const pi = {
    on(event: string, handler: (event: unknown) => void) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => {
        listeners.set(event, (listeners.get(event) ?? []).filter((h) => h !== handler));
      };
    },
    sendUserMessage(content: string) {
      steers.push(content);
    },
  } as unknown as ExtensionAPI;
  const ctx = { isIdle: () => true, hasPendingMessages: () => false } as unknown as ExtensionContext;
  const gate = createHostMessageGate(pi, ctx);
  const emit = (event: string, payload: unknown = {}) => {
    for (const handler of listeners.get(event) ?? []) handler(payload as never);
  };
  emit("turn_start");
  assert.equal(gate.trySend("during-run"), false, "a running turn must never be prompted even if isIdle lies");
  gate.send("queued-during-run");
  assert.deepEqual(steers, [], "nothing is sent while the turn runs");
  emit("agent_end", { messages: [] });
  assert.equal(gate.trySend("between-end-and-settled"), false, "the end-of-run window is not yet settled");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(steers, [], "agent_end alone must not green-light a delivery");
  // Older Pi runtimes do not expose agent_settled. A stable idle window is the
  // compatibility fallback, but it must still drain only one host message.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(steers.length, 1, "the queued result drains after a stable idle fallback");
  assert.equal(steers[0], "queued-during-run");
});

test("a host gate serializes sends before the next lifecycle boundary", () => {
  const steers: string[] = [];
  const pi = {
    on() {},
    sendUserMessage(content: string) {
      steers.push(content);
    },
  } as unknown as ExtensionAPI;
  const ctx = { isIdle: () => true, hasPendingMessages: () => false } as unknown as ExtensionContext;
  const gate = createHostMessageGate(pi, ctx);
  assert.equal(gate.trySend("first"), true);
  assert.equal(gate.trySend("second"), false, "a second result must not race the prompt started by the first");
  assert.deepEqual(steers, ["first"]);
});

test("a disposed host gate releases its lifecycle listeners", () => {
  let nonce = 0;
  const listeners = new Map<string, Array<() => void>>();
  const pi = {
    on(event: string, handler: () => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      return () => {
        listeners.set(event, (listeners.get(event) ?? []).filter((h) => h !== handler));
      };
    },
    sendUserMessage() {
      nonce += 1;
    },
  } as unknown as ExtensionAPI;
  const ctx = { isIdle: () => true, hasPendingMessages: () => false } as unknown as ExtensionContext;
  const gate = createHostMessageGate(pi, ctx);
  assert.equal(listeners.get("turn_start")?.length, 1, "the gate subscribes to turn_start");
  assert.equal(listeners.get("agent_end")?.length, 1, "the gate subscribes to agent_end");
  assert.equal(listeners.get("agent_settled")?.length, 1, "the gate registers the optional modern event when available");
  gate.dispose();
  assert.equal(listeners.get("turn_start")?.length, 0, "turn_start listener is released on dispose");
  assert.equal(listeners.get("agent_end")?.length, 0, "agent_end listener is released on dispose");
  assert.equal(listeners.get("agent_settled")?.length, 0, "agent_settled listener is released on dispose");
  assert.equal(nonce, 0);
});

test("a background result raced into an active run is delivered after the run settles", async () => {
  const cwd = projectRoot();
  try {
    const { pi, handlers, steers } = registrationsWithSteer();
    const ctx = {
      ...context(cwd, "root-a"),
      isIdle: () => true,
      hasPendingMessages: () => false,
    } as unknown as ExtensionContext;
    registerSessionEvents(pi);
    await handlers.get("session_start")!({ reason: "startup" }, ctx);
    // The runner misreports idle in the delivery window; only the explicit
    // lifecycle latch (turn_start..agent_settled) holds delivery back.
    await handlers.get("turn_start")!({ turnIndex: 0, timestamp: 1 }, ctx);
    const sessionFile = join(cwd, "sessions", "root-a.jsonl");
    const sent = getChildPool(cwd, "root-a").deliveryFor("root-a").deliverResult("job-a", sessionFile, "result-a");
    assert.equal(sent, false, "a racing result is kept durable pending");
    assert.deepEqual(steers, [], "no prompt while the turn runs");
    await handlers.get("agent_end")!({ messages: [] }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(steers, [], "agent_end alone must not deliver into the unsettled window");
    // This fixture models the legacy 0.80 runtime, where agent_settled is not
    // an extension event. The stable-idle fallback must redrive the durable
    // result without requiring a reload or a second user turn.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(steers, ["result-a"], "the result reaches the host after stable idle fallback");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session_shutdown disposes the host gate so a stale context cannot crash the host", async () => {
  const cwd = projectRoot();
  try {
    // A reload lands while the host is mid-run and a reload notice is queued
    // behind the gate's backoff timer.
    markSessionReload(cwd);
    let idle = false;
    const { pi, handlers, steers } = registrationsWithSteer();
    const ctx = {
      ...context(cwd, "root-a"),
      isIdle: () => idle,
      hasPendingMessages: () => false,
    } as unknown as ExtensionContext;
    registerSessionEvents(pi);
    await handlers.get("session_start")!({ reason: "reload" }, ctx);
    assert.deepEqual(steers, []);

    // The session is replaced: shutdown disposes the gate. The context then
    // behaves like pi's invalidated runner, whose getters throw.
    await handlers.get("session_shutdown")!({ reason: "reload" }, ctx);
    idle = true;
    Object.assign(ctx, {
      isIdle: () => {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      },
      hasPendingMessages: () => {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      },
    });

    // Advance well past the gate's backoff window: the disposed gate must not
    // fire a timer, must not throw, and must not deliver the stale notice.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(steers, [], "the replaced session must never deliver through a stale gate");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
