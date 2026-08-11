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
