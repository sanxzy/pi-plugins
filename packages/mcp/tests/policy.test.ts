import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluatePolicy,
  globToRegExp,
  mergeMcpPolicies,
  policyFromConfig,
  type McpPolicy,
} from "../src/index.ts";

const policy: McpPolicy = {
  tool: [
    { effect: "deny", server: "secret-*", name: "*" },
    { effect: "ask", server: "github", name: "delete_*" },
  ],
  prompt: [{ effect: "deny", server: "unsafe", name: "*" }],
  resource: [{ effect: "allow", server: "docs", name: "file:///*" }],
};

test("glob patterns match exact server and MCP item names", () => {
  assert.equal(globToRegExp("secret-*").test("secret-prod"), true);
  assert.equal(globToRegExp("secret-*").test("public"), false);
  assert.equal(evaluatePolicy(policy, "tool", "secret-prod", "read").effect, "deny");
  assert.equal(evaluatePolicy(policy, "tool", "github", "delete_repo").effect, "ask");
  assert.equal(evaluatePolicy(policy, "tool", "github", "list_repo").effect, "allow");
  assert.equal(evaluatePolicy(policy, "resource", "docs", "file:///a").effect, "allow");
});

test("default policy allows unmatched calls and project rules have precedence", () => {
  const user: McpPolicy = { tool: [{ effect: "allow", server: "server", name: "danger" }], prompt: [], resource: [] };
  const project: McpPolicy = { tool: [{ effect: "deny", server: "server", name: "danger" }], prompt: [], resource: [] };
  const merged = mergeMcpPolicies(user, project);
  assert.equal(evaluatePolicy(merged, "tool", "server", "danger").effect, "deny");
  assert.equal(evaluatePolicy(merged, "tool", "server", "safe").effect, "allow");
});

test("policyFromConfig accepts permissions and rejects malformed rules safely", () => {
  const policy = policyFromConfig({
    tools: [
      { effect: "deny", server: "private", name: "read" },
      { effect: "invalid", server: "ignored" },
      { effect: "ask", name: "write" },
    ],
    prompts: [{ effect: "deny", server: "x" }],
  });
  assert.deepEqual(policy.tool, [
    { effect: "deny", server: "private", name: "read" },
    { effect: "ask", name: "write" },
  ]);
  assert.deepEqual(policy.prompt, [{ effect: "deny", server: "x" }]);
  assert.deepEqual(policy.resource, []);
});
