import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalProjectRoot, clearSettingsCache, homePonytailStateFile, writePonytailState } from "@xzy-ai/runtime";
import { createSessionLogger, runWithLogContext } from "@xzy-ai/observability";
import { createPonytailEditTool, createPonytailWriteTool, editParams, executeEdit, executeWrite, registerWriteTool, writeParams } from "../src/index.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((block) => block.type === "text")?.text ?? "";
}
function home(): string { return mkdtempSync(join(tmpdir(), "pi-c2-we-home-")); }
function project(): string { return mkdtempSync(join(tmpdir(), "pi-c2-we-project-")); }
function context(cwd: string, sessionId = "we-session"): ExtensionContext {
  return { cwd, mode: "print", hasUI: false, sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionContext;
}
function scope(root: string, ...segments: string[]): string {
  const raw = join(canonicalProjectRoot(root), ...segments);
  // Canonical scopes must equal their real path (macOS /tmp -> /private/tmp).
  try {
    return realpathSync(raw);
  } catch {
    // Missing directory: canonicalize through the nearest existing ancestor.
    let ancestor = raw;
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    const canonical = realpathSync(ancestor);
    return resolve(canonical, relative(ancestor, raw));
  }
}
function ticket(scopePath: string, expiresAt = Date.now() + 60_000): { value: string; scopes: string[]; createdAt: number; expiresAt: number } {
  return { value: "opaque-we-ticket", scopes: [scopePath], createdAt: Date.now() - 1_000, expiresAt };
}
function enabledState(tickets: Array<{ value: string; scopes: string[]; createdAt: number; expiresAt: number }>): { version: 1; enabled: boolean; tickets: Array<{ value: string; scopes: string[]; createdAt: number; expiresAt: number }> } {
  return { version: 1, enabled: true, tickets };
}

test("the write and edit definitions require the Ponytail ticket parameter", () => {
  const writeDef = createPonytailWriteTool();
  const editDef = createPonytailEditTool();
  assert.equal(writeDef.name, "write");
  assert.equal(editDef.name, "edit");
  const writeSchema = writeParams as unknown as { required?: unknown; additionalProperties?: unknown; properties: Record<string, unknown> };
  const editSchema = editParams as unknown as { required?: unknown; additionalProperties?: unknown; properties: Record<string, unknown> };
  for (const schema of [writeSchema, editSchema]) {
    assert.equal(schema.additionalProperties, false);
    assert.ok("ticket" in schema.properties, "ticket is a declared parameter");
  }
  assert.deepEqual(Object.keys(writeSchema.properties).sort(), ["content", "path", "ticket"].sort());
  assert.deepEqual(Object.keys(editSchema.properties).sort(), ["edits", "path", "ticket"].sort());
  assert.deepEqual(writeSchema.required, ["path", "content", "ticket"]);
  assert.deepEqual(editSchema.required, ["path", "edits", "ticket"]);
});

test("enabled session writes through a valid covering ticket and blocks missing/expired/out-of-scope tickets", async () => {
  const h = home(); const root = project(); mkdirSync(join(root, "src"));
  try {
    // The temp home must stay active for BOTH the state write and the executor
    // call; restore it only after all assertions.
    const previous = process.env.PI_C2_TEST_HOME;
    process.env.PI_C2_TEST_HOME = h;
    clearSettingsCache();
    try {
      writePonytailState("we-session", enabledState([ticket(scope(root, "src"))]));
      // Valid covering ticket writes the file.
      const ok = await executeWrite({ path: "src/new/file.ts", content: "x", ticket: "opaque-we-ticket" }, context(root));
      assert.doesNotMatch(textOf(ok), /^Error:/);
      assert.equal(existsSync(join(root, "src", "new", "file.ts")), true);
      // Missing ticket blocks before mutation.
      const missing = await executeWrite({ path: "src/other.ts", content: "x", ticket: "" }, context(root));
      assert.match(textOf(missing), /^Error:/);
      assert.equal(existsSync(join(root, "src", "other.ts")), false);
      // Expired ticket blocks.
      writePonytailState("we-session", enabledState([ticket(scope(root, "src"), Date.now() - 1)]));
      const expired = await executeWrite({ path: "src/other.ts", content: "x", ticket: "opaque-we-ticket" }, context(root));
      assert.match(textOf(expired), /^Error:/);
      assert.equal(existsSync(join(root, "src", "other.ts")), false);
      // Out-of-scope ticket blocks.
      writePonytailState("we-session", enabledState([ticket(scope(root, "other"))]));
      const outOfScope = await executeWrite({ path: "src/other.ts", content: "x", ticket: "opaque-we-ticket" }, context(root));
      assert.match(textOf(outOfScope), /^Error:/);
      assert.equal(existsSync(join(root, "src", "other.ts")), false);
      // Wrong ticket value blocks.
      const wrong = await executeWrite({ path: "src/other.ts", content: "x", ticket: "not-the-ticket" }, context(root));
      assert.match(textOf(wrong), /^Error:/);
      assert.equal(existsSync(join(root, "src", "other.ts")), false);
    } finally {
      if (previous === undefined) delete process.env.PI_C2_TEST_HOME;
      else process.env.PI_C2_TEST_HOME = previous;
      clearSettingsCache();
    }
  } finally { rmSync(h, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("enabled session edit requires a covering ticket and edits only with one", async () => {
  const h = home(); const root = project(); mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "file.ts"), "line one\nline two\n", "utf8");
  try {
    const previous = process.env.PI_C2_TEST_HOME;
    process.env.PI_C2_TEST_HOME = h;
    clearSettingsCache();
    try {
      writePonytailState("we-session", enabledState([ticket(scope(root, "src"))]));
      const blocked = await executeEdit({ path: "src/file.ts", edits: [{ oldText: "line two", newText: "changed" }], ticket: "" }, context(root));
      assert.match(textOf(blocked), /^Error:/);
      assert.equal(readFileSync(join(root, "src", "file.ts"), "utf8"), "line one\nline two\n", "no mutation on blocked edit");
      const ok = await executeEdit({ path: "src/file.ts", edits: [{ oldText: "line two", newText: "changed" }], ticket: "opaque-we-ticket" }, context(root));
      assert.doesNotMatch(textOf(ok), /^Error:/);
      assert.equal(readFileSync(join(root, "src", "file.ts"), "utf8"), "line one\nchanged\n", "edit applied");
    } finally {
      if (previous === undefined) delete process.env.PI_C2_TEST_HOME;
      else process.env.PI_C2_TEST_HOME = previous;
      clearSettingsCache();
    }
  } finally { rmSync(h, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("missing and malformed state fail closed while an explicit disabled state delegates without a ticket", async () => {
  const h = home(); const root = project(); mkdirSync(join(root, "src"));
  try {
    const previous = process.env.PI_C2_TEST_HOME;
    process.env.PI_C2_TEST_HOME = h;
    clearSettingsCache();
    try {
      // Missing state (definition present but state deleted mid-session) fails closed.
      const missing = await executeWrite({ path: "src/a.ts", content: "x", ticket: "opaque-we-ticket" }, context(root, "missing-state"));
      assert.match(textOf(missing), /^Error:/);
      assert.equal(existsSync(join(root, "src", "a.ts")), false);
      // Malformed state fails closed.
      const statePath = homePonytailStateFile("broken-state");
      mkdirSync(join(h, "pi-c2", "sessions", "broken-state"), { recursive: true });
      writeFileSync(statePath, "{ broken");
      const broken = await executeWrite({ path: "src/a.ts", content: "x", ticket: "opaque-we-ticket" }, context(root, "broken-state"));
      assert.match(textOf(broken), /^Error:/);
      assert.equal(existsSync(join(root, "src", "a.ts")), false);
      // Explicitly disabled state is a stale-runtime edge: the wrapper is still
      // registered but the session was disabled; delegate without a ticket.
      writePonytailState("disabled-session", { version: 1, enabled: false, tickets: [] });
      const delegated = await executeWrite({ path: "src/b.ts", content: "x", ticket: "" }, context(root, "disabled-session"));
      assert.doesNotMatch(textOf(delegated), /^Error:/);
      assert.equal(existsSync(join(root, "src", "b.ts")), true);
    } finally {
      if (previous === undefined) delete process.env.PI_C2_TEST_HOME;
      else process.env.PI_C2_TEST_HOME = previous;
      clearSettingsCache();
    }
  } finally { rmSync(h, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("unsafe session identity and out-of-project targets block before any mutation", async () => {
  const h = home(); const root = project(); mkdirSync(join(root, "src")); const outside = project();
  try {
    const previous = process.env.PI_C2_TEST_HOME;
    process.env.PI_C2_TEST_HOME = h;
    clearSettingsCache();
    try {
      writePonytailState("we-session", enabledState([ticket(scope(root, "src"))]));
      for (const sessionId of ["bad/id", "../traversal", "."]) {
        const result = await executeWrite({ path: "src/a.ts", content: "x", ticket: "opaque-we-ticket" }, context(root, sessionId));
        assert.match(textOf(result), /^Error:/, sessionId);
        assert.doesNotMatch(textOf(result), /bad|traversal|secret/i, sessionId);
      }
      const escape = await executeWrite({ path: "../escape.ts", content: "x", ticket: "opaque-we-ticket" }, context(root));
      assert.match(textOf(escape), /^Error:/);
      assert.equal(existsSync(join(outside, "escape.ts")), false);
    } finally {
      if (previous === undefined) delete process.env.PI_C2_TEST_HOME;
      else process.env.PI_C2_TEST_HOME = previous;
      clearSettingsCache();
    }
  } finally { rmSync(h, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("enforcement logs contain only safe categories and never path, ticket, or content values", async () => {
  const h = home(); const root = project(); mkdirSync(join(root, "src"));
  const logDir = mkdtempSync(join(tmpdir(), "pi-c2-we-log-"));
  const eventsPath = join(logDir, "events.jsonl");
  try {
    const ticketValue = "opaque-log-secret";
    const target = join(root, "src", "blocked-secret.ts");
    const previous = process.env.PI_C2_TEST_HOME;
    process.env.PI_C2_TEST_HOME = h;
    clearSettingsCache();
    try {
      writePonytailState("we-session", enabledState([ticket(scope(root, "other"))]));
      const logger = createSessionLogger({ projectId: "project", rootSessionId: "we-session", eventsPath, errorsPath: join(logDir, "errors.jsonl") });
      await runWithLogContext(logger, async () => {
        await executeWrite({ path: target, content: "write-content-secret", ticket: ticketValue }, context(root));
      });
    } finally {
      if (previous === undefined) delete process.env.PI_C2_TEST_HOME;
      else process.env.PI_C2_TEST_HOME = previous;
      clearSettingsCache();
    }
    const raw = readFileSync(eventsPath, "utf8");
    assert.match(raw, /ponytail\.enforce/);
    assert.match(raw, /blocked/);
    for (const secret of [ticketValue, target, "write-content-secret"]) assert.equal(raw.includes(secret), false, `leaked ${secret}`);
  } finally { rmSync(h, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); rmSync(logDir, { recursive: true, force: true }); }
});

test("registration exposes the wrapper definitions through the extension API", () => {
  const names: string[] = [];
  let captured: { name: string; parameters: unknown } | undefined;
  const pi = {
    registerTool(tool: { name: string; parameters: unknown }) { names.push(tool.name); captured = tool; },
  } as unknown as ExtensionAPI;
  registerWriteTool(pi);
  assert.deepEqual(names, ["write"]);
  assert.equal(captured?.name, "write");
  assert.ok((captured?.parameters as { properties?: Record<string, unknown> })?.properties?.["ticket"], "ticket is in the registered parameters");
});
