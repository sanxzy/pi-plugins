import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_AGENT } from "@xzy-ai/core";
import type { DiscoveredAgent } from "@xzy-ai/core";
import { resolveChildTools } from "@xzy-ai/runtime";

const ALL_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

function discoveredAgent(tools?: string[]): DiscoveredAgent {
  return {
    name: "test-agent",
    isDefault: false,
    description: "Test agent",
    tools,
    systemPrompt: "",
    source: "project",
    filePath: "/tmp/test-agent.md",
  };
}

test("the default agent enables all seven built-in tools", () => {
  assert.deepEqual(resolveChildTools(DEFAULT_AGENT), ALL_BUILTIN_TOOLS);
});

test("an explicit non-empty tools list remains the child allowlist", () => {
  const tools = ["read", "grep"];
  assert.deepEqual(resolveChildTools(discoveredAgent(tools)), tools);
});

test("explicit child tool lists cannot enable goal capabilities", () => {
  const tools = ["read", "goal_create", "goal_pause", "goal_resume", "goal_status", "goal_clear"];
  assert.deepEqual(resolveChildTools(discoveredAgent(tools)), ["read"]);
});

test("an absent tools list enables all seven built-in tools", () => {
  assert.deepEqual(resolveChildTools(discoveredAgent()), ALL_BUILTIN_TOOLS);
});

test("an empty tools list enables all seven built-in tools", () => {
  assert.deepEqual(resolveChildTools(discoveredAgent([])), ALL_BUILTIN_TOOLS);
});

test("the default allowlist includes the read-only built-in tools", () => {
  const tools = resolveChildTools(DEFAULT_AGENT);
  assert.deepEqual(tools, ALL_BUILTIN_TOOLS);
  assert.ok(tools.includes("grep"));
  assert.ok(tools.includes("find"));
  assert.ok(tools.includes("ls"));
});
