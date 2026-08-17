import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalProjectRoot } from "@xzy-ai/runtime";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  clearSettingsCache,
  homePonytailStateFile,
  loadPonytailState,
  mutatePonytailState,
  startRootSession,
  type PonytailPersistence,
} from "@xzy-ai/runtime";
import {
  createWriteEditTicketParams,
  executeCreateWriteEditTicket,
  registerWriteEditTicketTool,
  type CreateWriteEditTicketParams,
} from "../src/registrations/ponytail-ticket.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((block) => block.type === "text")?.text ?? "";
}
function home(): string { return mkdtempSync(join(tmpdir(), "pi-c2-ticket-home-")); }
function project(): string { return mkdtempSync(join(tmpdir(), "pi-c2-ticket-project-")); }
function config(homeRoot: string, ttl = 600_000): void {
  mkdirSync(join(homeRoot, "pi-c2"), { recursive: true });
  writeFileSync(join(homeRoot, "pi-c2", "config.json"), JSON.stringify({ tools: { ponytailEnabled: true, writeEditTicketTtlMs: ttl } }));
}
function context(cwd: string, sessionId = "root-ticket"): ExtensionContext {
  return { cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionContext;
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
function input(directories: string[] = ["src"]): CreateWriteEditTicketParams {
  return {
    directories,
    doesNeedToExist: true,
    alreadyAvailableInCodebase: false,
    standardLibraryOrNativePlatformCanHandleIt: false,
    installedDependencyCanHandleIt: false,
    canBeOneLine: false,
    requiresNewDependency: false,
    hasClearVerificationPath: true,
  };
}
function setup(root: string, sessionId = "root-ticket", ttl = 600_000): void {
  config(process.env.PI_C2_TEST_HOME!, ttl);
  startRootSession({ projectRoot: root, sessionId });
}
function activateHome(homeRoot: string): void {
  process.env.PI_C2_TEST_HOME = homeRoot;
  clearSettingsCache();
}

test("create_write_edit_ticket exposes exactly the scoped seven-boolean contract", () => {
  const schema = createWriteEditTicketParams as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys((schema.properties as Record<string, unknown>)).sort(), [
    "alreadyAvailableInCodebase",
    "canBeOneLine",
    "directories",
    "doesNeedToExist",
    "hasClearVerificationPath",
    "installedDependencyCanHandleIt",
    "requiresNewDependency",
    "standardLibraryOrNativePlatformCanHandleIt",
  ].sort());
  assert.deepEqual(schema.required, [
    "directories",
    "doesNeedToExist",
    "alreadyAvailableInCodebase",
    "standardLibraryOrNativePlatformCanHandleIt",
    "installedDependencyCanHandleIt",
    "canBeOneLine",
    "requiresNewDependency",
    "hasClearVerificationPath",
  ]);
  assert.equal(schema.additionalProperties, false);
});

test("positive request persists a high-entropy ticket before returning ordered readable guidance", async () => {
  const h = home(); const root = project(); mkdirSync(join(root, "src"));
  try { withHome(h, () => setup(root)); activateHome(h);
    const result = await executeCreateWriteEditTicket(input(), context(root), { now: () => 1_000 });
    const text = textOf(result);
    assert.match(text, /^Write\/edit ticket: [A-Za-z0-9_-]+\nAdvisor:\n/);
    assert.equal(text.includes("doesNeedToExist"), false);
    assert.equal(text.includes("alreadyAvailableInCodebase"), false);
    assert.equal(text.includes("true"), false);
    assert.equal(text.includes("false"), false);
    assert.equal(text.includes("src"), false);
    assert.equal(text.includes("600000"), false);
    const state = withHome(h, () => loadPonytailState("root-ticket", 1_001));
    assert.equal(state?.tickets.length, 1);
    assert.equal(state?.tickets[0]?.scopes[0], join(canonicalProjectRoot(root), "src"));
    assert.equal(state?.tickets[0]?.createdAt, 1_000);
    assert.equal(state?.tickets[0]?.expiresAt, 601_000);
  } finally { rmSync(h, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("advisor returns deterministic polarity-specific guidance for every evaluation", async () => {
  const h = home(); const root = project(); mkdirSync(join(root, "src"));
  try { withHome(h, () => setup(root)); activateHome(h);
    const result = await executeCreateWriteEditTicket({ ...input(), alreadyAvailableInCodebase: true, standardLibraryOrNativePlatformCanHandleIt: true, installedDependencyCanHandleIt: true, canBeOneLine: true, requiresNewDependency: true, hasClearVerificationPath: false }, context(root), { now: () => 10 });
    const text = textOf(result);
    assert.match(text, /necessary/);
    assert.match(text, /existing codebase capability/);
    assert.match(text, /standard-library or native platform/);
    assert.match(text, /installed dependency/);
    assert.match(text, /efficient solution/);
    assert.match(text, /Wrap it behind an adapter/);
    assert.match(text, /well traced and verified/);
    assert.equal(text.split("\n").filter((line: string) => line.startsWith("- ")).length, 7);
  } finally { rmSync(h, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("false existence gate returns only YAGNI guidance and preserves tickets", async () => {
  const h = home(); const root = project(); mkdirSync(join(root, "src"));
  try { withHome(h, () => setup(root)); activateHome(h);
    const first = await executeCreateWriteEditTicket(input(), context(root), { now: () => 1_000 });
    const before = withHome(h, () => readFileSync(homePonytailStateFile("root-ticket"), "utf8"));
    const result = await executeCreateWriteEditTicket({ ...input(), doesNeedToExist: false }, context(root), { now: () => 2_000 });
    assert.equal(textOf(result), "Skip it and state why in one line. YAGNI — do not add code that does not need to exist.");
    assert.equal(withHome(h, () => readFileSync(homePonytailStateFile("root-ticket"), "utf8")), before);
    assert.ok(textOf(first).includes("Write/edit ticket:"));
  } finally { rmSync(h, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

for (const bad of ["", ".", "../outside", "/absolute", "src/../src"]) {
  test(`rejects unsafe directory input ${JSON.stringify(bad)} without changing state`, async () => {
    const h = home(); const root = project(); mkdirSync(join(root, "src"));
    try { withHome(h, () => setup(root)); activateHome(h);
      await executeCreateWriteEditTicket(input(), context(root), { now: () => 1_000 });
      const before = withHome(h, () => readFileSync(homePonytailStateFile("root-ticket"), "utf8"));
      const result = await executeCreateWriteEditTicket(input([bad]), context(root), { now: () => 2_000 });
      assert.match(textOf(result), /^Error:/);
      assert.equal(withHome(h, () => readFileSync(homePonytailStateFile("root-ticket"), "utf8")), before);
    } finally { rmSync(h, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
  });
}

test("rejects duplicate, nested, file, and symlink-escaping directories", async () => {
  const h = home(); const root = project(); mkdirSync(join(root, "src", "nested"), { recursive: true });
  const file = join(root, "file.txt"); writeFileSync(file, "x");
  const outside = project(); const link = join(root, "link"); symlinkSync(outside, link);
  try { withHome(h, () => setup(root)); activateHome(h);
    for (const directories of [["src", "src"], ["src", "src/nested"], ["file.txt"], ["link"]]) {
      const result = await executeCreateWriteEditTicket(input(directories), context(root), { now: () => 1_000 });
      assert.match(textOf(result), /^Error:/, directories.join(","));
    }
    assert.equal(withHome(h, () => loadPonytailState("root-ticket", 1_000)?.tickets.length), 0);
  } finally { rmSync(h, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("accepts missing nested directories under the project and retains independent tickets", async () => {
  const h = home(); const root = project(); mkdirSync(join(root, "src"));
  try { withHome(h, () => setup(root, "root-ticket", 100_000)); activateHome(h);
    const first = await executeCreateWriteEditTicket(input(["src"]), context(root), { now: () => 1_000 });
    const second = await executeCreateWriteEditTicket(input(["new/deep"]), context(root), { now: () => 2_000 });
    assert.notEqual(textOf(first), textOf(second));
    const state = withHome(h, () => loadPonytailState("root-ticket", 2_001));
    assert.equal(state?.tickets.length, 2);
    assert.deepEqual(state?.tickets.map((ticket) => ticket.scopes[0]), [join(canonicalProjectRoot(root), "src"), join(canonicalProjectRoot(root), "new/deep")]);
  } finally { rmSync(h, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("persistence failure returns a safe error and leaves the prior ticket set active", async () => {
  const h = home(); const root = project(); mkdirSync(join(root, "src"));
  try { withHome(h, () => setup(root)); activateHome(h);
    await executeCreateWriteEditTicket(input(["src"]), context(root), { now: () => 1_000 });
    const statePath = withHome(h, () => homePonytailStateFile("root-ticket"));
    const persistence: PonytailPersistence = {
      readJson: (path) => JSON.parse(readFileSync(path, "utf8")),
      writeJson: () => { throw new Error("disk failure"); },
      rename: () => { throw new Error("rename failure"); },
      list: () => [], exists: (path) => existsSync(path), chmod: () => undefined,
    };
    const result = await executeCreateWriteEditTicket(input(["other"]), context(root), { now: () => 2_000, persistence });
    assert.match(textOf(result), /^Error:/);
    assert.equal(withHome(h, () => loadPonytailState("root-ticket", 2_001)?.tickets.length), 1);
    assert.equal(statePath.endsWith("ponytail.json"), true);
  } finally { rmSync(h, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("missing session identity fails closed and the registration exposes the tool contract", async () => {
  const h = home(); const root = project(); mkdirSync(join(root, "src"));
  try { withHome(h, () => setup(root)); activateHome(h);
    const result = await executeCreateWriteEditTicket(input(), { ...context(root), sessionManager: { getSessionId: () => "" } } as unknown as ExtensionContext);
    assert.match(textOf(result), /session identity/i);
    let tool: unknown;
    registerWriteEditTicketTool({ registerTool: (candidate: unknown) => { tool = candidate; } } as unknown as ExtensionAPI);
    assert.equal((tool as { name: string }).name, "create_write_edit_ticket");
  } finally { rmSync(h, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});
