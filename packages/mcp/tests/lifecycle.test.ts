import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerMcpLifecycle } from "../src/index.ts";

interface HandlerMap {
  handlers: Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>;
}

function fakePi(): HandlerMap & { on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void): void } {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
  return {
    handlers,
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
}

function context(cwd: string, sessionId: string) {
  return {
    cwd,
    sessionManager: { getSessionId: () => sessionId },
  };
}

test("registerMcpLifecycle starts isolated managers for each session and stops them", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-mcp-lifecycle-"));
  const agentDir = join(root, "agent");
  const firstProject = join(root, "first");
  const secondProject = join(root, "second");
  const pi = fakePi();
  let watchers = 0;
  let unsubscribes = 0;

  registerMcpLifecycle(pi as never, {
    agentDir,
    watch() {
      watchers += 1;
      return () => {
        unsubscribes += 1;
      };
    },
  });

  const start = pi.handlers.get("session_start")!;
  const shutdown = pi.handlers.get("session_shutdown")!;
  await start({ reason: "startup" }, context(firstProject, "session-a"));
  await start({ reason: "startup" }, context(secondProject, "session-a"));
  assert.equal(watchers, 2);

  await shutdown({ reason: "quit" }, context(firstProject, "session-a"));
  assert.equal(unsubscribes, 1);
  await shutdown({ reason: "quit" }, context(secondProject, "session-a"));
  assert.equal(unsubscribes, 2);

  rmSync(root, { recursive: true, force: true });
});

test("repeated session start does not create a second manager for the same session", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-mcp-lifecycle-repeat-"));
  const pi = fakePi();
  let watchers = 0;
  registerMcpLifecycle(pi as never, {
    agentDir: join(root, "agent"),
    watch() {
      watchers += 1;
      return () => undefined;
    },
  });

  const ctx = context(join(root, "project"), "same-session");
  await pi.handlers.get("session_start")!({ reason: "startup" }, ctx);
  await pi.handlers.get("session_start")!({ reason: "reload" }, ctx);
  assert.equal(watchers, 1);

  await pi.handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
  rmSync(root, { recursive: true, force: true });
});
