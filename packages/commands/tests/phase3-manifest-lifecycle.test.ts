import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readSessionManifest } from "@xzy-ai/runtime";
import { encodeProjectId, homeAgentDir, homeAgentEventsFile, homeAgentManifestFile, homeDailyEventFile } from "@xzy-ai/runtime";
import { registerSessionEvents } from "../src/registrations/session-events.ts";

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-c2-phase3-command-project-"));
}

function registrations(): { pi: ExtensionAPI; handlers: Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown> } {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown>();
  return {
    handlers,
    pi: {
      on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown) {
        handlers.set(event, handler);
      },
      setActiveTools() {},
      getAllTools() { return []; },
    } as unknown as ExtensionAPI,
  };
}

function context(cwd: string, sessionId: string): ExtensionContext {
  return {
    mode: "tui",
    hasUI: false,
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => join(cwd, `${sessionId}.jsonl`),
    },
  } as unknown as ExtensionContext;
}

test("root session lifecycle emits correlated home-scoped session events", async () => {
  const previousHome = process.env.PI_C2_TEST_HOME;
  const home = mkdtempSync(join(tmpdir(), "pi-c2-phase3-log-home-"));
  process.env.PI_C2_TEST_HOME = home;
  const cwd = projectRoot();
  try {
    const { pi, handlers } = registrations();
    registerSessionEvents(pi);
    const ctx = context(cwd, "root-session");
    await handlers.get("session_start")!({ reason: "startup" }, ctx);
    await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
    const eventsPath = homeDailyEventFile(encodeProjectId(cwd), "root-session", new Date().toISOString().slice(0, 10));
    const events = readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(events.length >= 4, "session lifecycle should emit before/after pairs");
    assert.equal(events[0]?.operation, "session.start");
    assert.equal(events[0]?.phase, "before");
    const startAfter = events.find((record) => record.operation === "session.start" && record.phase === "after");
    const stopAfter = events.find((record) => record.operation === "session.stop" && record.phase === "after");
    assert.ok(startAfter, "session.start after record missing");
    assert.ok(stopAfter, "session.stop after record missing");
    assert.equal(startAfter?.projectId, encodeProjectId(cwd));
    assert.equal(stopAfter?.rootSessionId, "root-session");
  } finally {
    if (previousHome === undefined) delete process.env.PI_C2_TEST_HOME;
    else process.env.PI_C2_TEST_HOME = previousHome;
  }
});

test("production session lifecycle creates and finishes the home session manifest", async () => {
  const previousHome = process.env.PI_C2_TEST_HOME;
  const home = mkdtempSync(join(tmpdir(), "pi-c2-phase3-command-home-"));
  process.env.PI_C2_TEST_HOME = home;
  const cwd = projectRoot();
  try {
    const { pi, handlers } = registrations();
    registerSessionEvents(pi);
    const ctx = context(cwd, "root-session");
    await handlers.get("session_start")!({ reason: "startup" }, ctx);
    assert.equal(readSessionManifest(cwd, "root-session").active, true);
    await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
    const manifest = readSessionManifest(cwd, "root-session");
    assert.equal(manifest.active, false);
    assert.equal(manifest.pid, process.pid);
    assert.ok(manifest.processStartTime);
  } finally {
    if (previousHome === undefined) delete process.env.PI_C2_TEST_HOME;
    else process.env.PI_C2_TEST_HOME = previousHome;
  }
});
