import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createSessionLogger, runWithLogContext } from "@xzy-ai/observability";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  canonicalProjectRoot,
  clearSettingsCache,
  homePonytailStateFile,
  writePonytailState,
} from "@xzy-ai/runtime";
import { registerPonytailEnforcement } from "../src/registrations/ponytail-enforcement.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function home(): string { return mkdtempSync(join(tmpdir(), "pi-c2-enforcement-home-")); }
function project(): string { return mkdtempSync(join(tmpdir(), "pi-c2-enforcement-project-")); }
function enableHome(homeRoot: string): void {
  mkdirSync(join(homeRoot, "pi-c2"), { recursive: true });
  writeFileSync(join(homeRoot, "pi-c2", "config.json"), JSON.stringify({ tools: { ponytailEnabled: true } }));
  process.env.PI_C2_TEST_HOME = homeRoot;
  clearSettingsCache();
}
function context(cwd: string, sessionId = "enforcement-session"): ExtensionContext {
  return { cwd, mode: "print", hasUI: false, sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionContext;
}
function withHome<T>(homeRoot: string, run: () => T): T {
  const previous = process.env.PI_C2_TEST_HOME;
  process.env.PI_C2_TEST_HOME = homeRoot;
  clearSettingsCache();
  try { return run(); } finally {
    if (previous === undefined) delete process.env.PI_C2_TEST_HOME;
    else process.env.PI_C2_TEST_HOME = previous;
    clearSettingsCache();
  }
}
function ticket(scope: string, expiresAt = Date.now() + 60_000) {
  return { value: "opaque-test-ticket", scopes: [scope], createdAt: Date.now() - 1_000, expiresAt };
}
function registration(): { handler: Handler; pi: ExtensionAPI } {
  let handler: Handler | undefined;
  const pi = {
    on(event: string, candidate: Handler) { if (event === "tool_call") handler = candidate; },
  } as unknown as ExtensionAPI;
  registerPonytailEnforcement(pi);
  if (!handler) throw new Error("tool_call handler was not registered");
  return { handler, pi };
}
async function call(handler: Handler, toolName: string, input: Record<string, unknown>, ctx: ExtensionContext): Promise<{ block?: boolean; reason?: string } | undefined> {
  return await handler({ type: "tool_call", toolCallId: "call-1", toolName, input }, ctx) as { block?: boolean; reason?: string } | undefined;
}

test("allows an exact or descendant target under any unexpired ticket before write/edit execution", async () => {
  const h = home(); const root = project(); mkdirSync(join(root, "src"));
  try {
    const scope = join(canonicalProjectRoot(root), "src");
    writeFileSync(join(root, "src", "existing.ts"), "existing-secret-content");
    withHome(h, () => writePonytailState("enforcement-session", { version: 1, enabled: true, tickets: [ticket(scope)] }));
    process.env.PI_C2_TEST_HOME = h; clearSettingsCache();
    const { handler } = registration(); const ctx = context(root);
    assert.deepEqual(await call(handler, "write", { path: "src/new/deep/file.ts", content: "x" }, ctx), undefined);
    assert.deepEqual(await call(handler, "edit", { path: "src/existing.ts", edits: [{ oldText: "x", newText: "y" }] }, ctx), undefined);
  } finally { rmSync(h, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("blocks siblings, parents, prefix collisions, escapes, and symlink targets", async () => {
  const h = home(); const root = project(); const outside = project();
  enableHome(h);
  mkdirSync(join(root, "src", "nested"), { recursive: true }); mkdirSync(join(root, "src-backup"));
  writeFileSync(join(root, "src", "file.ts"), "x"); symlinkSync(outside, join(root, "escape"));
  try {
    const scope = join(canonicalProjectRoot(root), "src");
    withHome(h, () => writePonytailState("enforcement-session", { version: 1, enabled: true, tickets: [ticket(scope)] }));
    process.env.PI_C2_TEST_HOME = h; clearSettingsCache();
    const { handler } = registration(); const ctx = context(root);
    for (const path of ["src/../src/file.ts", "src-backup/file.ts", "other/file.ts", "escape/file.ts", resolve(root, "../outside.ts")]) {
      const result = await call(handler, "write", { path, content: "x" }, ctx);
      assert.equal(result?.block, true, path);
      assert.match(result?.reason ?? "", /ticket|unsafe|scope|target/i);
    }
  } finally { rmSync(h, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("blocks missing identity, missing/malformed/expired authorization, and exposes no sensitive data", async () => {
  const h = home(); const root = project(); mkdirSync(join(root, "src"));
  try {
    withHome(h, () => enableHome(h));
    process.env.PI_C2_TEST_HOME = h; clearSettingsCache();
    const { handler } = registration();
    const missing = await call(handler, "write", { path: "src/file.ts", content: "secret-content" }, { ...context(root), sessionManager: { getSessionId: () => "" } } as unknown as ExtensionContext);
    assert.equal(missing?.block, true); assert.match(missing?.reason ?? "", /identity/i); assert.doesNotMatch(missing?.reason ?? "", /secret-content|opaque-test-ticket/);
    const absent = await call(handler, "write", { path: "src/file.ts", content: "secret-content" }, context(root, "absent"));
    assert.equal(absent?.block, true); assert.match(absent?.reason ?? "", /Ponytail|ticket/i);
    withHome(h, () => writePonytailState("enforcement-session", { version: 1, enabled: true, tickets: [ticket(join(canonicalProjectRoot(root), "src"), Date.now() - 1)] }));
    process.env.PI_C2_TEST_HOME = h; clearSettingsCache();
    const expired = await call(handler, "edit", { path: "src/file.ts", edits: [] }, context(root));
    assert.equal(expired?.block, true); assert.match(expired?.reason ?? "", /expired|ticket|scope/i);
  } finally { rmSync(h, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("disabled sessions preserve built-in write/edit behavior and bash stays outside the boundary", async () => {
  const h = home(); const root = project(); mkdirSync(join(root, "src"));
  try {
    withHome(h, () => writePonytailState("disabled", { version: 1, enabled: false, tickets: [] }));
    process.env.PI_C2_TEST_HOME = h; clearSettingsCache();
    const { handler } = registration(); const ctx = context(root, "disabled");
    assert.deepEqual(await call(handler, "write", { path: "src/file.ts", content: "x" }, ctx), undefined);
    assert.deepEqual(await call(handler, "edit", { path: "src/file.ts", edits: [] }, ctx), undefined);
    assert.deepEqual(await call(handler, "bash", { command: "printf secret" }, ctx), undefined);
    assert.equal(existsSync(homePonytailStateFile("disabled")), true);
  } finally { rmSync(h, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("enforcement logs only safe categories and never ticket, path, state, or content values", async () => {
  const h = home(); const root = project(); mkdirSync(join(root, "src"));
  const logDir = mkdtempSync(join(tmpdir(), "pi-c2-ponytail-log-"));
  const eventsPath = join(logDir, "events.jsonl");
  try {
    const ticketValue = "opaque-ticket-log-secret";
    const target = join(root, "src", "blocked-secret.ts");
    withHome(h, () => writePonytailState("enforcement-session", {
      version: 1, enabled: true,
      tickets: [{ value: ticketValue, scopes: [join(canonicalProjectRoot(root), "other")], createdAt: Date.now() - 1_000, expiresAt: Date.now() + 60_000 }],
    }));
    process.env.PI_C2_TEST_HOME = h; clearSettingsCache();
    const { handler } = registration();
    const logger = createSessionLogger({ projectId: "project", rootSessionId: "enforcement-session", eventsPath, errorsPath: join(logDir, "errors.jsonl") });
    await runWithLogContext(logger, async () => {
      await call(handler, "write", { path: target, content: "write-content-secret" }, context(root));
    });
    const raw = readFileSync(eventsPath, "utf8");
    assert.match(raw, /ponytail\.enforce/);
    assert.match(raw, /blocked/);
    for (const secret of [ticketValue, target, "write-content-secret"]) assert.equal(raw.includes(secret), false, `leaked ${secret}`);
  } finally { rmSync(h, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); rmSync(logDir, { recursive: true, force: true }); }
});
