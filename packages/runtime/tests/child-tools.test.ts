import assert from "node:assert/strict";
import { test } from "node:test";
import type { DiscoveredAgent } from "@xzy-ai/core";
import { resolveChildTools } from "@xzy-ai/runtime";

const ALL_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const ALL_CHILD_TOOLS = [...ALL_BUILTIN_TOOLS, "web_search", "web_fetch", "llm_wikis_search"];

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

test("an explicit non-empty tools list keeps the allowlist and appends the web tools", () => {
  const tools = ["read", "grep"];
  assert.deepEqual(resolveChildTools(discoveredAgent(tools)), [...tools, "web_search", "web_fetch", "llm_wikis_search"]);
});

test("explicit child tool lists cannot enable goal capabilities but gain the web tools", () => {
  const tools = ["read", "goal_create", "goal_pause", "goal_resume", "goal_status", "goal_clear"];
  assert.deepEqual(resolveChildTools(discoveredAgent(tools)), ["read", "web_search", "web_fetch", "llm_wikis_search"]);
});

test("an absent tools list enables all seven built-in tools plus the web tools", () => {
  assert.deepEqual(resolveChildTools(discoveredAgent()), ALL_CHILD_TOOLS);
});

test("an empty tools list enables all seven built-in tools plus the web tools", () => {
  assert.deepEqual(resolveChildTools(discoveredAgent([])), ALL_CHILD_TOOLS);
});

test("the fallback allowlist includes the read-only built-in and web tools", () => {
  const tools = resolveChildTools(discoveredAgent());
  assert.deepEqual(tools, ALL_CHILD_TOOLS);
  assert.ok(tools.includes("grep"));
  assert.ok(tools.includes("find"));
  assert.ok(tools.includes("ls"));
  assert.ok(tools.includes("web_search"));
  assert.ok(tools.includes("web_fetch"));
  assert.ok(tools.includes("llm_wikis_search"));
});
