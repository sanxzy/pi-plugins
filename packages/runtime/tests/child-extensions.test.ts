import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getChildExtensionFactories, registerChildExtensionFactory } from "@xzy-ai/runtime";

/**
 * Regression test for the child-session extension fix.
 *
 * A child builds its own isolated `DefaultResourceLoader` via
 * `createAgentSession`, so it never inherits the host's inline extension
 * factories. `registerChildExtensionFactory`/`getChildExtensionFactories` are
 * the runtime seam; this test drives a real loader the same way
 * `createIsolatedChild` does and asserts that a registered inline factory is
 * actually loaded into the child extension set.
 */

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("child extension factories are loaded into an isolated DefaultResourceLoader", async () => {
  const root = tempRoot("pi-code-child-ext-");
  const agentDir = join(root, "agent");
  try {
    const registered: string[] = [];
    const factory = (pi: ExtensionAPI) => {
      pi.registerTool?.({
        name: "agent",
        description: "fake agent tool",
        parameters: { type: "object" },
        execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
      } as never);
      registered.push("called");
    };
    registerChildExtensionFactory(factory);

    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.create(root, agentDir),
      extensionFactories: getChildExtensionFactories(),
    });
    await loader.reload();
    const ex = loader.getExtensions();
    const tools = [...new Set(ex.extensions.flatMap((entry) => [...entry.tools.keys()]))];
    assert.ok(ex.extensions.length > 0, "inline factory loaded into the child loader");
    assert.ok(tools.includes("agent"), "registered tool is constructible in the child registry");
    assert.deepEqual(registered, ["called"], "registered factory runs exactly once");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("named extension factories replace the previous closure across reloads", () => {
  const factories = getChildExtensionFactories();
  const before = factories.filter((entry) => typeof entry === "object" && entry.name === "test-child-ext").length;
  const factory = ({ name: "test-child-ext" as string, factory: () => {} });
  registerChildExtensionFactory(factory);
  const once = getChildExtensionFactories().filter((entry) => typeof entry === "object" && entry.name === "test-child-ext");
  assert.equal(once.length, 1, "named factory registered once");
  // Re-registering the same named factory replaces the entry, never duplicates.
  registerChildExtensionFactory({ name: "test-child-ext", factory: () => {} });
  const after = getChildExtensionFactories().filter((entry) => typeof entry === "object" && entry.name === "test-child-ext");
  assert.equal(after.length, 1, "named factory stays unique after re-registration");
  assert.equal(before + 1, after.length);
});
