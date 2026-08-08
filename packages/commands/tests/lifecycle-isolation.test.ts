import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createJob, type ChildSessionControl } from "@xzy-ai/core";
import { getChildPool } from "@xzy-ai/runtime";
import { registerLifecycleGates } from "../src/registrations/lifecycle-gates.ts";
import { registerSessionEvents } from "../src/registrations/session-events.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function context(cwd: string, sessionId: string, confirm: (title: string, message: string) => Promise<boolean>): ExtensionContext {
  return {
    mode: "tui",
    hasUI: true,
    cwd,
    ui: { confirm },
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

function addRunningJob(cwd: string, parentSessionId: string, jobId: string, parentJobId?: string): void {
  const pool = getChildPool(cwd, "root-a");
  pool.registry.createJob(createJob({
    jobId,
    parentSessionId,
    parentJobId,
    rootJobId: parentJobId ?? jobId,
    depth: parentJobId === undefined ? 0 : 1,
    sessionId: jobId,
    status: "running",
    description: jobId,
    subagentType: "default",
  }));
}

function control(abort: () => Promise<void>): ChildSessionControl {
  return { sessionFile: undefined, steer: async () => {}, abort };
}

test("/new confirmation counts only running jobs owned by the active parent session", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-lifecycle-isolation-"));
  try {
    addRunningJob(cwd, "root-a", "a-running");
    addRunningJob(cwd, "root-b", "b-running");
    const seen: string[] = [];
    const d = registrations();
    registerLifecycleGates(d.pi);
    const result = await d.handlers.get("session_before_switch")!({ reason: "new" }, context(cwd, "root-a", async (title, message) => {
      seen.push(`${title}: ${message}`);
      return true;
    }));
    assert.deepEqual(result, { cancel: false });
    assert.deepEqual(seen, ["Running background agents: 1 background agent(s) are still running. Starting a new session will stop them. Continue?"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("shutdown interrupts only running jobs rooted at the active parent session", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-lifecycle-isolation-"));
  try {
    addRunningJob(cwd, "root-a", "a-running");
    addRunningJob(cwd, "job-a", "a-grandchild", "a-running");
    addRunningJob(cwd, "root-b", "b-running");
    const pool = getChildPool(cwd, "root-a");
    const aborted: string[] = [];
    pool.liveChildren.set("a-running", control(async () => { aborted.push("a-running"); }));
    pool.liveChildren.set("a-grandchild", control(async () => { aborted.push("a-grandchild"); }));
    pool.liveChildren.set("b-running", control(async () => { aborted.push("b-running"); }));

    const d = registrations();
    registerSessionEvents(d.pi);
    await d.handlers.get("session_shutdown")!({ reason: "quit" }, context(cwd, "root-a", async () => true));

    assert.equal(pool.registry.get("a-running")?.status, "interrupted");
    assert.equal(pool.registry.get("a-grandchild")?.status, "interrupted");
    assert.equal(pool.registry.get("b-running")?.status, "running");
    assert.deepEqual(aborted.sort(), ["a-grandchild", "a-running"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
