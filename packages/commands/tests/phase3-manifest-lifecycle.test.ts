import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readSessionManifest } from "@xzy-ai/runtime";
import { encodeProjectId, homeAgentDir, homeAgentEventsFile, homeAgentManifestFile } from "@xzy-ai/runtime";
import { registerSessionEvents } from "../src/registrations/session-events.ts";

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-phase3-command-project-"));
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

test("production session lifecycle creates and finishes the home session manifest", async () => {
  const previousHome = process.env.PI_CODE_TEST_HOME;
  const home = mkdtempSync(join(tmpdir(), "pi-code-phase3-command-home-"));
  process.env.PI_CODE_TEST_HOME = home;
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
    if (previousHome === undefined) delete process.env.PI_CODE_TEST_HOME;
    else process.env.PI_CODE_TEST_HOME = previousHome;
  }
});
