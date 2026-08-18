import assert from "node:assert/strict";
import { test } from "node:test";
import { getChildPonytailTools, registerChildPonytailTools, resolveChildCustomTools } from "@xzy-ai/runtime";

function def(name: string) {
  return {
    name,
    label: name,
    description: `desc ${name}`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
  };
}

test("registerChildPonytailTools publishes a single replaceable slot", () => {
  const first = { write: def("write"), edit: def("edit") };
  const second = { write: def("write"), edit: def("edit") };
  registerChildPonytailTools(first);
  assert.equal(getChildPonytailTools(), first);
  registerChildPonytailTools(second);
  assert.equal(getChildPonytailTools(), second, "re-registration replaces the previous entry");
});

test("resolveChildCustomTools appends Ponytail write/edit only when enabled and definitions exist", () => {
  const mcp = def("server_tool");
  const ponytail = { write: def("write"), edit: def("edit") };
  const bridge = {
    invokeTool: async () => ({ content: [{ type: "text", text: "bridge" }] }),
    listResources: () => [],
    readResource: async () => ({ content: [] }),
  };
  // Enabled with definitions: MCP defs first, then write/edit.
  const enabled = resolveChildCustomTools({ mcpToolDefs: [mcp], mcpEnabled: true, mcpBridge: bridge, ponytailEnabled: true, ponytailTools: ponytail });
  assert.deepEqual(enabled.map((t) => t.name), ["server_tool", "write", "edit"]);
  // Disabled: only MCP defs (normal built-in write/edit remain).
  const disabled = resolveChildCustomTools({ mcpToolDefs: [mcp], mcpEnabled: true, mcpBridge: bridge, ponytailEnabled: false, ponytailTools: ponytail });
  assert.deepEqual(disabled.map((t) => t.name), ["server_tool"]);
  // Enabled but no published definitions: no Ponytail tools injected.
  const noDefs = resolveChildCustomTools({ ponytailEnabled: true, ponytailTools: undefined });
  assert.deepEqual(noDefs.map((t) => t.name), []);
  // MCP bridge disabled: MCP defs omitted entirely.
  const noMcp = resolveChildCustomTools({ mcpToolDefs: [mcp], mcpEnabled: false, mcpBridge: bridge, ponytailEnabled: true, ponytailTools: ponytail });
  assert.deepEqual(noMcp.map((t) => t.name), ["write", "edit"]);
});

test("resolveChildCustomTools omits MCP defs when the bridge is unavailable", () => {
  const mcp = def("server_tool");
  const ponytail = { write: def("write"), edit: def("edit") };
  const tools = resolveChildCustomTools({ mcpToolDefs: [mcp], mcpEnabled: true, ponytailEnabled: true, ponytailTools: ponytail });
  assert.deepEqual(tools.map((t) => t.name), ["write", "edit"]);
});
