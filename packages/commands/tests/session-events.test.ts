import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createJob } from "@xzy-ai/core";
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
  return mkdtempSync(join(tmpdir(), "pi-code-session-events-"));
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

    // The in-flight run settles: the gate drains its queue at agent_end (the
    // very next backoff tick).
    idle = true;
    await handlers.get("agent_end")!({ messages: [] });
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

