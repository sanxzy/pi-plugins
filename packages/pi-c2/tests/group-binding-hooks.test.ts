import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPatches, parsePatch, reversePatch } from "diff";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_PATCH = join(HERE, "../scripts/pi-coding-agent@0.84.2.patch");
const SDK_SOURCE = new URL("../node_modules/@earendil-works/pi-coding-agent", import.meta.url).pathname;
const TARGET_REL = "dist/core/agent-session.js";

/** Apply a parsed patch over a source tree using jsdiff callbacks. */
async function applyTo(copyFrom: string, patchText: string, reverse = false): Promise<string> {
  const dest = mkdtempSync(join(tmpdir(), "pi-c2-hook-fixture-"));
  cpSync(join(copyFrom, "package.json"), join(dest, "package.json"));
  cpSync(join(copyFrom, "dist"), join(dest, "dist"), { recursive: true });
  const parsed = parsePatch(patchText);
  const patch = reverse ? reversePatch(parsed) : parsed;
  await new Promise<void>((resolve, reject) => {
    applyPatches(patch as never, {
      loadFile(index, callback) {
        const rel = String(index.newFileName ?? "").replace(/^[ab]\//, "");
        const file = join(dest, rel);
        callback(null, existsSync(file) ? readFileSync(file, "utf8") : "");
      },
      patched(index, content, callback) {
        const rel = String(index.newFileName ?? "").replace(/^[ab]\//, "");
        if (content === false) return callback(new Error(`patch did not apply to ${rel}`));
        mkdirSync(dirname(join(dest, rel)), { recursive: true });
        writeFileSync(join(dest, rel), content);
        callback(null);
      },
      complete(error) {
        if (error) reject(error);
        else resolve();
      },
    });
  });
  return dest;
}

/** Read agent-session.js from the freshly patched tree. */
async function patchedAgentSession(): Promise<string> {
  const bundledText = readFileSync(BUNDLED_PATCH, "utf8");
  // The installed SDK copy already carries the previous patch: reverse it to
  // pristine first (mirroring patch-sync), then apply the bundled patch.
  const pristine = await applyTo(SDK_SOURCE, bundledText, true);
  try {
    const patched = await applyTo(pristine, bundledText, false);
    try {
      return readFileSync(join(patched, TARGET_REL), "utf8");
    } finally {
      rmSync(patched, { recursive: true, force: true });
    }
  } finally {
    rmSync(pristine, { recursive: true, force: true });
  }
}

/** Extract one pi-c2 inserted block (marker comment through its closing `} catch {}`). */
function extractBlock(source: string, marker: string, indent: string): string {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `marker found: ${marker}`);
  const end = source.indexOf(`${indent}} catch {}`, start);
  assert.notEqual(end, -1, `closing catch found: ${marker}`);
  const raw = source.slice(start - indent.length, end + indent.length + "} catch {}".length);
  // Surface otherwise-swallowed internal errors so behavioral tests fail loudly.
  return raw.replace("} catch {}", '} catch (hookError) { throw new Error("hook internal: " + String(hookError && typeof hookError === "object" ? hookError.message : hookError)); }');
}

/**
 * Compile an extracted block into a callable invoked with a fake `this`.
 * Free identifiers from the original method scope (e.g. `msg`) are injected
 * through compiled parameters so their references resolve like in situ.
 */
function compileBlock(block: string, freeVars: Record<string, unknown> = {}): (self: unknown) => unknown {
  const names = Object.keys(freeVars);
  const values = names.map((name) => freeVars[name]);
  const factory = new Function("globalThis", ...names, '"use strict";\nreturn function () {\n' + block + '\n};');
  const fn = factory(globalThis, ...values);
  return (self: unknown): unknown => fn.call(self);
}


interface FakeGroupApiCalls {
  resolveActiveArgs: unknown[];
  reportFailureArgs: Array<[string, string | undefined]>;
  resolveNext?: { ref: string; thinking?: string };
  reportNext?: { ref: string; thinking?: string };
}

let fakeCalls: FakeGroupApiCalls | undefined;

function installFakeApis(registryEntries: Record<string, unknown>, calls: FakeGroupApiCalls): void {
  fakeCalls = calls;
  (globalThis as Record<symbol, unknown>)[Symbol.for("pi-c2.child-model-bindings")] = {
    bindings: new Map(Object.entries(registryEntries)),
    getChildModelBinding(sessionId: string | undefined) {
      return sessionId ? registryEntries[sessionId] : undefined;
    },
  };
  (globalThis as Record<symbol, unknown>)[Symbol.for("pi-c2.model-groups")] = {
    resolveActive(groupId?: string) {
      calls.resolveActiveArgs.push(groupId);
      return calls.resolveNext;
    },
    reportFailure(failedRef: string, groupId?: string) {
      calls.reportFailureArgs.push([failedRef, groupId]);
      return calls.reportNext;
    },
  };
}

function clearFakeApis(): void {
  fakeCalls = undefined;
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-c2.child-model-bindings")];
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-c2.model-groups")];
}

interface FakeSelf {
  self: Record<string, unknown>;
  thinkingLevels: string[];
}

function fakeSelf(sessionId: string): FakeSelf {
  const thinkingLevels: string[] = [];
  const self: Record<string, unknown> = {
    sessionId,
    model: { provider: "prov", id: "one" },
    _modelRuntime: {
      getModel(provider: string, id: string) {
        if (provider === "prov" && id === "two") return { provider, id, contextWindow: 1000 };
        return undefined;
      },
    },
    agent: { state: { model: undefined as unknown, messages: [] as Array<{ role: string }> } },
    setThinkingLevel(level: string) {
      thinkingLevels.push(level);
    },
  };
  return { self, thinkingLevels };
}

/** A representative provider error message carrying an HTTP status. */
function errorMessage(): { stopReason: string; errorMessage: string } {
  return { stopReason: "error", errorMessage: "HTTP 503 Service Unavailable: overloaded upstream" };
}

test("turn_start: pinned sessions never consult the group api", async () => {
  const source = await patchedAgentSession();
  const hook = compileBlock(extractBlock(source, "// pi-c2: advance round-robin groups on every individual model request.", "            "));
  const calls: FakeGroupApiCalls = { resolveActiveArgs: [], reportFailureArgs: [] };
  installFakeApis({ sess: { kind: "pinned" } }, calls);
  try {
    const { self } = fakeSelf("sess");
    hook(self);
    assert.deepEqual(calls.resolveActiveArgs, [], "group api must not be touched for pinned sessions");
  } finally {
    clearFakeApis();
  }
});

test("turn_start: group-bound sessions advance their named group", async () => {
  const source = await patchedAgentSession();
  const hook = compileBlock(extractBlock(source, "// pi-c2: advance round-robin groups on every individual model request.", "            "));
  const calls: FakeGroupApiCalls = { resolveActiveArgs: [], reportFailureArgs: [], resolveNext: { ref: "prov/two", thinking: "member-thinking" } };
  installFakeApis({ sess: { kind: "group", groupId: "beta" } }, calls);
  try {
    const { self, thinkingLevels } = fakeSelf("sess");
    hook(self);
    assert.deepEqual(calls.resolveActiveArgs, ["beta"], "the bound group id is passed through");
    const state = (self.agent as { state: { model?: unknown } }).state;
    assert.deepEqual(state.model, { provider: "prov", id: "two", contextWindow: 1000 }, "state.model follows the resolved member");
    assert.deepEqual(thinkingLevels, ["member-thinking"]);
  } finally {
    clearFakeApis();
  }
});

test("turn_start: unbound sessions follow the home-wide active selection", async () => {
  const source = await patchedAgentSession();
  const hook = compileBlock(extractBlock(source, "// pi-c2: advance round-robin groups on every individual model request.", "            "));
  const calls: FakeGroupApiCalls = { resolveActiveArgs: [], reportFailureArgs: [] };
  installFakeApis({}, calls);
  try {
    const { self } = fakeSelf("sess");
    hook(self);
    assert.deepEqual(calls.resolveActiveArgs, [undefined], "no binding resolves the active selection");
  } finally {
    clearFakeApis();
  }
});

test("failure: pinned sessions skip quarantine handling entirely", async () => {
  const source = await patchedAgentSession();
  const hook = compileBlock(
    extractBlock(source, "// pi-c2: quarantine group members on HTTP 4xx/5xx", "        "),
    { msg: errorMessage() },
  );
  const calls: FakeGroupApiCalls = { resolveActiveArgs: [], reportFailureArgs: [] };
  installFakeApis({ sess: { kind: "pinned" } }, calls);
  try {
    const { self } = fakeSelf("sess");
    const returned = hook(self);
    assert.equal(returned, undefined, "the block defers to normal retry handling");
    assert.deepEqual(calls.reportFailureArgs, []);
  } finally {
    clearFakeApis();
  }
});

test("failure: a member failure inside a bound group quarantines and continues with the next member", async () => {
  const source = await patchedAgentSession();
  let extracted = extractBlock(source, "// pi-c2: quarantine group members on HTTP 4xx/5xx", "        ");
  extracted = extracted.replace("} catch {}", "} catch (swallowedError) { console.log(\"SWALLOWED:\", swallowedError?.message, swallowedError?.stack?.split('\\n')[1]); }");
  extracted = extracted.replace('const groupApi = globalThis[Symbol.for("pi-c2.model-groups")];\n                if (msg.stopReason', 'console.log("DBG before msg check");const groupApi = globalThis[Symbol.for("pi-c2.model-groups")];\n                if (msg.stopReason');
  
  const hook = compileBlock(extracted, { msg: errorMessage() });
  const calls: FakeGroupApiCalls = {
    resolveActiveArgs: [],
    reportFailureArgs: [],
    reportNext: { ref: "prov/two" },
  };
  installFakeApis({ sess: { kind: "group", groupId: "beta" } }, calls);
  try {
    const { self, thinkingLevels } = fakeSelf("sess");
    (self.agent as { state: { messages: Array<{ role: string }> } }).state.messages = [
      { role: "user" },
      { role: "assistant" },
    ];
    const returned = hook(self);
    console.log("MEMBER-DBG returned=", returned, "args=", JSON.stringify(calls.reportFailureArgs));
    assert.equal(returned, true, "the hook takes over the retry with a replacement model");
    assert.deepEqual(
      calls.reportFailureArgs,
      [["prov/one", "beta"]],
      "the failing member is reported into the BOUND group",
    );
    const state = (self.agent as { state: { model?: unknown; messages: Array<{ role: string }> } }).state;
    assert.deepEqual(state.model, { provider: "prov", id: "two", contextWindow: 1000 });
    assert.deepEqual(state.messages.map((m) => m.role), ["user"], "the failed assistant turn is dropped");
    assert.deepEqual(thinkingLevels, []);
  } finally {
    clearFakeApis();
  }
});

test("failure: an unbound session reports into the home-wide active group only", async () => {
  const source = await patchedAgentSession();
  const hook = compileBlock(
    extractBlock(source, "// pi-c2: quarantine group members on HTTP 4xx/5xx", "        "),
    { msg: errorMessage() },
  );
  const calls: FakeGroupApiCalls = { resolveActiveArgs: [], reportFailureArgs: [] };
  installFakeApis({}, calls);
  try {
    const { self } = fakeSelf("sess");
    const returned = hook(self);
    assert.equal(returned, undefined, "a non-member failure yields no replacement");
    assert.deepEqual(calls.reportFailureArgs, [["prov/one", undefined]]);
  } finally {
    clearFakeApis();
  }
});
