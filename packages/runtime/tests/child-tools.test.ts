import assert from "node:assert/strict";
import { test } from "node:test";
import type { DiscoveredAgent } from "@xzy-ai/core";
import { resolveChildTools } from "@xzy-ai/runtime";

const ALL_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const ALL_AGENT_TOOLS = ["agent", "agent_list", "agent_jobs", "agent_status", "agent_cancel"];
const ALL_CHILD_TOOLS = [...ALL_BUILTIN_TOOLS, ...ALL_AGENT_TOOLS, "web_search", "web_fetch", "llm_wikis_search"];

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

test("an explicit non-empty tools list keeps the allowlist and appends the agent + web tools", () => {
  const tools = ["read", "grep"];
  assert.deepEqual(resolveChildTools(discoveredAgent(tools)), [
    ...tools,
    "agent",
    "agent_list",
    "agent_jobs",
    "agent_status",
    "agent_cancel",
    "web_search",
    "web_fetch",
    "llm_wikis_search",
  ]);
});

test("explicit child tool lists cannot enable goal or MCP capabilities but always gain the agent + web tools", () => {
  const tools = [
    "read",
    "goal_create",
    "goal_pause",
    "goal_resume",
    "goal_status",
    "goal_clear",
    "mcp_resources_list",
    "mcp_resources_read",
    "mcp",
  ];
  assert.deepEqual(resolveChildTools(discoveredAgent(tools)), [
    "read",
    ...ALL_AGENT_TOOLS,
    "web_search",
    "web_fetch",
    "llm_wikis_search",
  ]);
});

test("an absent tools list enables built-in, discovered MCP, agent, and web tools", () => {
  assert.deepEqual(resolveChildTools(discoveredAgent(), ["alpha_lookup", "beta_search"]), [
    ...ALL_BUILTIN_TOOLS,
    "alpha_lookup",
    "beta_search",
    ...ALL_AGENT_TOOLS,
    "web_search",
    "web_fetch",
    "llm_wikis_search",
  ]);
});

test("an empty tools list enables all built-in tools plus the agent and web tools", () => {
  assert.deepEqual(resolveChildTools(discoveredAgent([])), ALL_CHILD_TOOLS);
});

test("an explicit list that omits agent tools still gains the agent fallback set", () => {
  assert.deepEqual(resolveChildTools(discoveredAgent(["read"])), [
    "read",
    "agent",
    "agent_list",
    "agent_jobs",
    "agent_status",
    "agent_cancel",
    "web_search",
    "web_fetch",
    "llm_wikis_search",
  ]);
});

test("discovered MCP tools are filtered through child restrictions and root-only controls, gaining agent + web", () => {
  assert.deepEqual(resolveChildTools(discoveredAgent(["read", "alpha_lookup", "goal_create"]), ["alpha_lookup", "beta_search", "mcp_resources_list"]), [
    "read",
    "alpha_lookup",
    ...ALL_AGENT_TOOLS,
    "web_search",
    "web_fetch",
    "llm_wikis_search",
  ]);
});

test("the fallback allowlist includes the read-only built-in, agent, and web tools", () => {
  const tools = resolveChildTools(discoveredAgent(), []);
  assert.deepEqual(tools, ALL_CHILD_TOOLS);
  assert.ok(tools.includes("grep"));
  assert.ok(tools.includes("find"));
  assert.ok(tools.includes("ls"));
  assert.ok(tools.includes("web_search"));
  assert.ok(tools.includes("web_fetch"));
  assert.ok(tools.includes("llm_wikis_search"));
  assert.ok(tools.includes("agent"));
  assert.ok(tools.includes("agent_list"));
  assert.ok(tools.includes("agent_jobs"));
  assert.ok(tools.includes("agent_status"));
  assert.ok(tools.includes("agent_cancel"));
  for (const rootOnly of ["goal_create", "mcp_resources_list"]) {
    assert.ok(!tools.includes(rootOnly), `${rootOnly} must stay root-only`);
  }
});
