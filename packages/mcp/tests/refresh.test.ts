import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createMcpManager, userConfigPath } from "../src/index.ts";

const fixture = new URL("./fixtures/refresh-server.ts", import.meta.url).pathname;

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("list-change notification refreshes the live manager catalog and removes stale entries", async () => {
  const root = temp("pi-code-mcp-refresh-");
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  const stateFile = join(root, "state.json");
  const notifyFile = join(root, "notify");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ prompts: ["old_prompt"], resources: ["file:///old"] }));
  writeFileSync(notifyFile, "0");
  writeFileSync(userConfigPath(agentDir), JSON.stringify({ mcp: { servers: {
    refresh: { type: "local", command: [process.execPath, fixture], environment: {
      MCP_REFRESH_STATE_FILE: stateFile,
      MCP_REFRESH_NOTIFY_FILE: notifyFile,
    } },
  } } }));
  let changed = 0;
  const manager = createMcpManager({ agentDir, projectRoot, onCatalogChanged: () => {
    changed += 1;
    // Mirror lifecycle wiring: refresh the live catalog, then reconcile.
    void manager.refreshCatalog("refresh").then(() => undefined, () => undefined);
  } });
  try {
    await manager.start();
    assert.deepEqual(manager.promptsFor("refresh")?.map((p) => p.name), ["old_prompt"]);
    assert.deepEqual(manager.resourcesFor("refresh")?.map((r) => r.uri), ["file:///old"]);
    writeFileSync(stateFile, JSON.stringify({ prompts: ["new_prompt"], resources: ["file:///new"] }));
    writeFileSync(notifyFile, "1");
    utimesSync(notifyFile, new Date(), new Date(Date.now() + 10));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(changed >= 1, "the list-change notification reached the manager callback");
    assert.deepEqual(manager.promptsFor("refresh")?.map((p) => p.name), ["new_prompt"]);
    assert.deepEqual(manager.resourcesFor("refresh")?.map((r) => r.uri), ["file:///new"]);
  } finally {
    await manager.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("manager prompt and resource calls preserve an already-aborted signal", async () => {
  const root = temp("pi-code-mcp-refresh-abort-");
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  const stateFile = join(root, "state.json");
  const notifyFile = join(root, "notify");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ prompts: ["p"], resources: ["file:///r"] }));
  writeFileSync(notifyFile, "0");
  writeFileSync(userConfigPath(agentDir), JSON.stringify({ mcp: { servers: {
    refresh: { type: "local", command: [process.execPath, fixture], environment: { MCP_REFRESH_STATE_FILE: stateFile, MCP_REFRESH_NOTIFY_FILE: notifyFile } },
  } } }));
  const manager = createMcpManager({ agentDir, projectRoot });
  const controller = new AbortController();
  controller.abort();
  try {
    await manager.start();
    await assert.rejects(manager.getPrompt("refresh", "p", {}, controller.signal), /abort|cancel/i);
    await assert.rejects(manager.readResource("refresh", "file:///r", controller.signal), /abort|cancel/i);
  } finally {
    await manager.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
