import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createJob } from "@xzy-ai/core";
import { canonicalProjectRoot, clearSettingsCache, getChildPool, homePonytailStateFile, startRootSession, writePonytailState } from "@xzy-ai/runtime";
import { registerPonytailSetup } from "../src/registrations/ponytail-setup.ts";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

function home(): string { return mkdtempSync(join(tmpdir(), "pi-c2-ponytail-setup-home-")); }
function project(): string { return mkdtempSync(join(tmpdir(), "pi-c2-ponytail-setup-project-")); }
function registrations(): { handler: CommandHandler; commands: Map<string, unknown> } {
  const commands = new Map<string, unknown>();
  const pi = { registerCommand(name: string, options: { handler: CommandHandler }) { commands.set(name, options); } } as unknown as ExtensionAPI;
  registerPonytailSetup(pi);
  const command = commands.get("c2-setup-ponytail") as { handler?: CommandHandler } | undefined;
  if (!command?.handler) throw new Error("c2-setup-ponytail was not registered");
  return { handler: command.handler, commands };
}
function context(cwd: string, sessionId: string, select: (title: string, options: string[]) => Promise<string | undefined>, reload?: () => Promise<void>, sessionFile?: string): ExtensionCommandContext {
  return {
    cwd, mode: "tui", hasUI: true,
    ui: { select, notify() {} },
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile ?? join(cwd, `${sessionId}.jsonl`) },
    reload,
  } as unknown as ExtensionCommandContext;
}
function withHome(homeRoot: string, run: () => Promise<void>): Promise<void> {
  const previous = process.env.PI_C2_TEST_HOME;
  process.env.PI_C2_TEST_HOME = homeRoot; clearSettingsCache();
  return run().finally(() => {
    if (previous === undefined) delete process.env.PI_C2_TEST_HOME;
    else process.env.PI_C2_TEST_HOME = previous;
    clearSettingsCache();
  });
}
function state(sessionId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(homePonytailStateFile(sessionId), "utf8")) as Record<string, unknown>;
}
/** Record the session as a live root so the root-only gate accepts it. */
function registerRoot(cwd: string, sessionId: string): void {
  startRootSession({ projectRoot: cwd, sessionId, sessionFile: join(cwd, `${sessionId}.jsonl`) });
}
/** Record a live child session so the root-only gate rejects it. */
function registerChild(cwd: string, sessionId: string): void {
  const pool = getChildPool(cwd, sessionId);
  pool.registry.createJob(createJob({ jobId: `child-${sessionId}`, status: "running", description: "child", subagentType: "child", sessionId }));
}

test("registers root-only setup and presents current status with explicit enable/disable choices", async () => {
  const h = home(); const cwd = project(); const choices: string[][] = []; const notifications: string[] = [];
  try {
    await withHome(h, async () => {
      const { handler } = registrations();
      registerRoot(cwd, "setup-root");
      const ctx = context(cwd, "setup-root", async (_title, options) => { choices.push(options); return "Enable Ponytail"; }, async () => {});
      (ctx.ui as unknown as { notify: (message: string) => void }).notify = (message) => notifications.push(message);
      await handler("", ctx);
      assert.deepEqual(choices, [["Enable Ponytail", "Disable Ponytail"]]);
      assert.equal(state("setup-root").enabled, true);
      assert.equal(notifications.some((message) => /enabled|reload/i.test(message)), true);
    });
  } finally { rmSync(h, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); }
});

test("reports persistence and successful reload as separate outcomes", async () => {
  const h = home(); const cwd = project(); const notifications: string[] = [];
  try {
    await withHome(h, async () => {
      const { handler } = registrations();
      registerRoot(cwd, "reload-succeeds");
      const ctx = context(cwd, "reload-succeeds", async () => "Enable Ponytail", async () => {});
      (ctx.ui as unknown as { notify: (message: string) => void }).notify = (message) => notifications.push(message);
      await handler("", ctx);
      assert.equal(state("reload-succeeds").enabled, true);
      assert.equal(notifications.some((message) => /persisted successfully/i.test(message)), true);
      assert.equal(notifications.some((message) => /reload succeeded/i.test(message)), true);
    });
  } finally { rmSync(h, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); }
});

test("reports unavailable reload while retaining the persisted choice for the next lifecycle boundary", async () => {
  const h = home(); const cwd = project(); const notifications: string[] = [];
  try {
    await withHome(h, async () => {
      const { handler } = registrations();
      registerRoot(cwd, "reload-unavailable");
      const ctx = context(cwd, "reload-unavailable", async () => "Enable Ponytail");
      (ctx.ui as unknown as { notify: (message: string) => void }).notify = (message) => notifications.push(message);
      await handler("", ctx);
      assert.equal(state("reload-unavailable").enabled, true);
      assert.equal(notifications.some((message) => /persisted successfully/i.test(message)), true);
      assert.equal(notifications.some((message) => /reload unavailable/i.test(message)), true);
      assert.equal(notifications.some((message) => /runtime was not changed/i.test(message)), true);
      assert.equal(notifications.some((message) => /next successful reload or session start/i.test(message)), true);
    });
  } finally { rmSync(h, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); }
});

test("persists before reload and reports reload failure without discarding the choice", async () => {
  const h = home(); const cwd = project(); mkdirSync(join(cwd, "src")); const notifications: string[] = []; let persistedAtReload = false;
  try {
    await withHome(h, async () => {
      const { handler } = registrations();
      registerRoot(cwd, "reload-fails");
      const ctx = context(cwd, "reload-fails", async () => "Disable Ponytail", async () => {
        persistedAtReload = true;
        assert.equal(state("reload-fails").enabled, false);
        throw new Error("reload unavailable");
      });
      (ctx.ui as unknown as { notify: (message: string) => void }).notify = (message) => notifications.push(message);
      writePonytailState("reload-fails", { version: 1, enabled: true, tickets: [{ value: "keep-me", scopes: [join(canonicalProjectRoot(cwd), "src")], createdAt: 1, expiresAt: Date.now() + 60_000 }] });
      clearSettingsCache();
      await handler("", ctx);
      assert.equal(persistedAtReload, true);
      assert.equal(state("reload-fails").enabled, false);
      assert.equal((state("reload-fails").tickets as unknown[]).length, 1);
      assert.equal(notifications.some((message) => /reload failed|not changed/i.test(message)), true);
    });
  } finally { rmSync(h, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); }
});

test("rejects child sessions without changing root or child state", async () => {
  const h = home(); const cwd = project();
  try {
    await withHome(h, async () => {
      const { handler } = registrations();
      registerChild(cwd, "child-session");
      const ctx = context(cwd, "child-session", async () => "Enable Ponytail", async () => { throw new Error("must not reload"); });
      const notifications: string[] = [];
      (ctx.ui as unknown as { notify: (message: string) => void }).notify = (message) => notifications.push(message);
      await handler("", ctx);
      assert.equal(notifications.some((message) => /root|child|only/i.test(message)), true);
    });
  } finally { rmSync(h, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); }
});
