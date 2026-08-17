import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DiscoveredAgent } from "@xzy-ai/core";
import { initializeChildPonytailState, loadPonytailState, resolveChildTools, writePonytailState } from "@xzy-ai/runtime";

const ALL_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find"];
const ALL_AGENT_TOOLS = ["agent", "agent_list", "agent_jobs", "agent_status", "agent_cancel"];
const ALL_WEB_TOOLS = ["web_search", "web_fetch", "knowledge_search"];
const ALL_MCP_RESOURCE_TOOLS = ["mcp_resources_list", "mcp_resources_read"];
const MARKDOWN_TOOLS = ["write_markdown", "edit_markdown"];
const PONYTAIL_TOOL = "create_write_edit_ticket";

function discoveredAgent(tools?: string[]): DiscoveredAgent {
  return {
    name: "test-agent",
    description: "Test agent",
    tools,
    systemPrompt: "",
    source: "project",
    filePath: "/tmp/test-agent.md",
  };
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "pi-c2-child-md-home-"));
}

function withHome(home: string, run: () => void): void {
  const previous = process.env.PI_C2_TEST_HOME;
  process.env.PI_C2_TEST_HOME = home;
  try { run(); } finally {
    if (previous === undefined) delete process.env.PI_C2_TEST_HOME;
    else process.env.PI_C2_TEST_HOME = previous;
  }
}

test("an enabled child receives both dedicated markdown tools at creation and resume boundaries", () => {
  const tools = resolveChildTools(discoveredAgent(), [], 0, undefined, true, true);
  for (const name of [...MARKDOWN_TOOLS, PONYTAIL_TOOL]) assert.ok(tools.includes(name), `${name} present when enabled`);
});

test("a disabled child receives neither dedicated markdown tool, and explicit frontmatter cannot re-enable them", () => {
  const tools = resolveChildTools(discoveredAgent([...ALL_BUILTIN_TOOLS, ...MARKDOWN_TOOLS]), [], 0, undefined, true, false);
  for (const name of [...MARKDOWN_TOOLS, PONYTAIL_TOOL]) assert.equal(tools.includes(name), false, `${name} absent when disabled`);
});

test("the markdown tools appear once each in an enabled child allowlist", () => {
  const tools = resolveChildTools(discoveredAgent(), [], 0, undefined, true, true);
  for (const name of MARKDOWN_TOOLS) assert.equal(tools.filter((candidate) => candidate === name).length, 1, `${name} registered exactly once`);
});

test("a child boundary inherits the root enabled bit and roots never leak tickets into child state", async () => {
  const home = tempHome();
  try {
    await withHomeAsync(home, async () => {
      writePonytailState("root-md", { version: 1, enabled: true, tickets: [{ value: "root-ticket-secret", scopes: ["/project/src"], createdAt: 1, expiresAt: 10_000 }] });
      assert.equal(initializeChildPonytailState("root-md", "child-md", 2_000), true);
      const child = loadPonytailState("child-md", 2_000);
      assert.equal(child?.enabled, true);
      assert.deepEqual(child?.tickets, [], "root tickets are never copied into child state");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

function withHomeAsync(home: string, run: () => Promise<void>): Promise<void> {
  const previous = process.env.PI_C2_TEST_HOME;
  process.env.PI_C2_TEST_HOME = home;
  return run().finally(() => {
    if (previous === undefined) delete process.env.PI_C2_TEST_HOME;
    else process.env.PI_C2_TEST_HOME = previous;
  });
}

test("a running child's allowlist is not changed when the root toggles; the next boundary observes the root bit", () => {
  const home = tempHome();
  try {
    withHome(home, () => {
      writePonytailState("root-toggle", { version: 1, enabled: true, tickets: [] });
      const enabled = resolveChildTools(discoveredAgent(), [], 0, undefined, true, true);
      writePonytailState("root-toggle", { version: 1, enabled: false, tickets: [] });
      // The already-resolved allowlist snapshot is unchanged.
      for (const name of [...MARKDOWN_TOOLS, PONYTAIL_TOOL]) assert.ok(enabled.includes(name), `${name} retained in the running child snapshot`);
      // The next child boundary observes the disabled root bit.
      const disabled = resolveChildTools(discoveredAgent(), [], 0, undefined, true, false);
      for (const name of [...MARKDOWN_TOOLS, PONYTAIL_TOOL]) assert.equal(disabled.includes(name), false, `${name} absent after the root toggle boundary`);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
