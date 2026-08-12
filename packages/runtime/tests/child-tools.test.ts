import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DiscoveredAgent } from "@xzy-ai/core";
import { getChildExtensionFactories, maxAgentDepth, registerChildExtensionFactory, resolveChildTools } from "@xzy-ai/runtime";

const ALL_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find"];
const ALL_AGENT_TOOLS = ["agent", "agent_list", "agent_jobs", "agent_status", "agent_cancel"];
const ALL_WEB_TOOLS = ["web_search", "web_fetch", "llm_wikis_search"];
const ALL_MCP_RESOURCE_TOOLS = ["mcp_resources_list", "mcp_resources_read"];
const ALL_CHILD_TOOLS = [...ALL_BUILTIN_TOOLS, ...ALL_AGENT_TOOLS, ...ALL_WEB_TOOLS, ...ALL_MCP_RESOURCE_TOOLS];

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

test("child extension factories are retained for isolated child loaders", () => {
  const factory = (() => {}) as Parameters<typeof registerChildExtensionFactory>[0];
  registerChildExtensionFactory(factory);
  assert.ok(getChildExtensionFactories().includes(factory));
  assert.equal(getChildExtensionFactories().filter((candidate) => candidate === factory).length, 1);
});

test("an explicit non-empty tools list keeps the allowlist and appends agent, web, and MCP resource tools", () => {
  const tools = ["read", "grep"];
  assert.deepEqual(resolveChildTools(discoveredAgent(tools)), [
    ...tools,
    ...ALL_AGENT_TOOLS,
    ...ALL_WEB_TOOLS,
    ...ALL_MCP_RESOURCE_TOOLS,
  ]);
});

test("explicit child tool lists cannot enable goal or Telegram capabilities but always gain agent, web, and MCP resource tools", () => {
  const tools = [
    "read",
    "goal_create",
    "goal_pause",
    "goal_resume",
    "goal_status",
    "goal_clear",
    "telegram_chat",
  ];
  assert.deepEqual(resolveChildTools(discoveredAgent(tools)), [
    "read",
    ...ALL_AGENT_TOOLS,
    ...ALL_WEB_TOOLS,
    ...ALL_MCP_RESOURCE_TOOLS,
  ]);
});

test("an absent tools list enables built-in, discovered MCP, agent, web, and MCP resource tools", () => {
  assert.deepEqual(resolveChildTools(discoveredAgent(), ["alpha_lookup", "beta_search"]), [
    ...ALL_BUILTIN_TOOLS,
    ...ALL_AGENT_TOOLS,
    ...ALL_WEB_TOOLS,
    ...ALL_MCP_RESOURCE_TOOLS,
    "alpha_lookup",
    "beta_search",
  ]);
});

test("an empty tools list enables all built-in tools plus agent, web, and MCP resource tools", () => {
  assert.deepEqual(resolveChildTools(discoveredAgent([])), ALL_CHILD_TOOLS);
});

test("an explicit tools list is filtered so ls is never exposed to children", () => {
  assert.deepEqual(resolveChildTools(discoveredAgent(["read", "ls", "grep", "write"])), [
    "read",
    "grep",
    "write",
    ...ALL_AGENT_TOOLS,
    ...ALL_WEB_TOOLS,
    ...ALL_MCP_RESOURCE_TOOLS,
  ]);
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
    "mcp_resources_list",
    "mcp_resources_read",
  ]);
});

test("discovered MCP tools are filtered through child restrictions and root-only controls, gaining agent, web, and MCP resource tools", () => {
  assert.deepEqual(resolveChildTools(discoveredAgent(["read", "alpha_lookup", "goal_create"]), ["alpha_lookup", "beta_search"]), [
    "read",
    "alpha_lookup",
    ...ALL_AGENT_TOOLS,
    ...ALL_WEB_TOOLS,
    ...ALL_MCP_RESOURCE_TOOLS,
    "beta_search",
  ]);
});

test("the fallback allowlist includes built-in, agent, web, and MCP resource tools but never ls", () => {
  const tools = resolveChildTools(discoveredAgent(), []);
  assert.deepEqual(tools, ALL_CHILD_TOOLS);
  assert.ok(tools.includes("grep"));
  assert.ok(tools.includes("find"));
  assert.ok(!tools.includes("ls"), "ls must not be exposed to children");
  assert.ok(tools.includes("web_search"));
  assert.ok(tools.includes("web_fetch"));
  assert.ok(tools.includes("llm_wikis_search"), "llm_wikis_search must be exposed to every child");
  assert.ok(tools.includes("agent"));
  assert.ok(tools.includes("agent_list"));
  assert.ok(tools.includes("agent_jobs"));
  assert.ok(tools.includes("agent_status"));
  assert.ok(tools.includes("agent_cancel"));
  assert.ok(tools.includes("mcp_resources_list"));
  assert.ok(tools.includes("mcp_resources_read"));
  for (const rootOnly of ["goal_create", "telegram_chat"]) {
    assert.ok(!tools.includes(rootOnly), `${rootOnly} must stay root-only`);
  }
});

test("depth 0 through 3 retain agent-family tools while depth 4 is a terminal leaf", () => {
  for (const depth of [0, 1, 2, 3]) {
    const tools = resolveChildTools(discoveredAgent(), ["exa_web_search_exa"], depth);
    for (const name of ALL_AGENT_TOOLS) assert.ok(tools.includes(name), `${name} is available at depth ${depth}`);
    assert.ok(tools.includes("web_search"));
    assert.ok(tools.includes("web_fetch"));
    assert.ok(tools.includes("llm_wikis_search"));
    assert.ok(tools.includes("mcp_resources_list"));
    assert.ok(tools.includes("mcp_resources_read"));
    assert.ok(tools.includes("exa_web_search_exa"));
    assert.ok(!tools.includes("ls"));
  }

  const leaf = resolveChildTools(discoveredAgent(), ["exa_web_search_exa"], 4);
  for (const name of ALL_AGENT_TOOLS) assert.ok(!leaf.includes(name), `${name} is absent at terminal depth`);
  for (const name of [...ALL_BUILTIN_TOOLS, ...ALL_WEB_TOOLS, ...ALL_MCP_RESOURCE_TOOLS, "exa_web_search_exa"]) {
    assert.ok(leaf.includes(name), `${name} remains available at terminal depth`);
  }
  assert.ok(!leaf.includes("ls"));
});

test("maxAgentDepth falls back to the default when unset or invalid", () => {
  const previous = process.env.PI_CODE_MAX_AGENT_DEPTH;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "pi-code-depth-default-"));
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.PI_CODE_MAX_AGENT_DEPTH;
    const unset = maxAgentDepth();
    assert.equal(unset, 4, "default depth is 4 when unset");

    for (const invalid of ["", "0", "-1", "abc", "2.5", "999999999999999999999"]) {
      process.env.PI_CODE_MAX_AGENT_DEPTH = invalid;
      assert.equal(maxAgentDepth(), 4, `invalid value ${JSON.stringify(invalid)} falls back to default`);
    }
  } finally {
    if (previous === undefined) delete process.env.PI_CODE_MAX_AGENT_DEPTH;
    else process.env.PI_CODE_MAX_AGENT_DEPTH = previous;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("a configured max agent depth shifts the terminal leaf", () => {
  const previous = process.env.PI_CODE_MAX_AGENT_DEPTH;
  try {
    process.env.PI_CODE_MAX_AGENT_DEPTH = "2";
    assert.equal(maxAgentDepth(), 2);

    // Depth 0–1 still spawn agents; depth 2 is now the terminal leaf.
    for (const depth of [0, 1]) {
      const tools = resolveChildTools(discoveredAgent(), ["exa_web_search_exa"], depth);
      for (const name of ALL_AGENT_TOOLS) assert.ok(tools.includes(name), `${name} is available at depth ${depth}`);
    }
    const leaf = resolveChildTools(discoveredAgent(), ["exa_web_search_exa"], 2);
    for (const name of ALL_AGENT_TOOLS) assert.ok(!leaf.includes(name), `${name} is absent at terminal depth 2`);
    for (const name of [...ALL_BUILTIN_TOOLS, ...ALL_WEB_TOOLS, ...ALL_MCP_RESOURCE_TOOLS, "exa_web_search_exa"]) {
      assert.ok(leaf.includes(name), `${name} remains available at terminal depth 2`);
    }
    assert.ok(!leaf.includes("ls"));
  } finally {
    if (previous === undefined) delete process.env.PI_CODE_MAX_AGENT_DEPTH;
    else process.env.PI_CODE_MAX_AGENT_DEPTH = previous;
  }
});

test("project and user pi-code config files set the max agent depth with precedence", () => {
  const previousEnvDepth = process.env.PI_CODE_MAX_AGENT_DEPTH;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = mkdtempSync(join(tmpdir(), "pi-code-depth-config-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(join(agentDir, "pi-code"), { recursive: true });
  try {
    delete process.env.PI_CODE_MAX_AGENT_DEPTH;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    // Default when nothing is configured.
    assert.equal(maxAgentDepth(cwd), 4);

    // User-level config is applied.
    writeFileSync(join(agentDir, "pi-code", "config.json"), JSON.stringify({ maxAgentDepth: 3 }));
    assert.equal(maxAgentDepth(cwd), 3, "user config applies");

    // Project-level overrides user.
    writeFileSync(join(cwd, ".pi", "pi-code.json"), JSON.stringify({ maxAgentDepth: 2 }));
    assert.equal(maxAgentDepth(cwd), 2, "project config overrides user");

    // Env overrides both.
    process.env.PI_CODE_MAX_AGENT_DEPTH = "7";
    assert.equal(maxAgentDepth(cwd), 7, "env overrides project and user");

    // Invalid values in files are ignored (treated as unset).
    delete process.env.PI_CODE_MAX_AGENT_DEPTH;
    writeFileSync(join(cwd, ".pi", "pi-code.json"), JSON.stringify({ maxAgentDepth: "2" }));
    assert.equal(maxAgentDepth(cwd), 3, "invalid project value falls back to user config");
    writeFileSync(join(cwd, ".pi", "pi-code.json"), JSON.stringify({ maxAgentDepth: 0 }));
    assert.equal(maxAgentDepth(cwd), 3, "non-positive project value falls back to user config");
    writeFileSync(join(agentDir, "pi-code", "config.json"), "{ not json");
    writeFileSync(join(cwd, ".pi", "pi-code.json"), JSON.stringify({ maxAgentDepth: -1 }));
    assert.equal(maxAgentDepth(cwd), 4, "malformed/invalid sources fall back to the default");
  } finally {
    if (previousEnvDepth === undefined) delete process.env.PI_CODE_MAX_AGENT_DEPTH;
    else process.env.PI_CODE_MAX_AGENT_DEPTH = previousEnvDepth;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});
