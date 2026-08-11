import assert from "node:assert/strict";
import { test } from "node:test";
import { McpToolExposer } from "../src/expose.ts";
import { type McpToolSnapshotEntry } from "../src/expose.ts";

function fakePi() {
  const tools = new Map<string, { name: string; description: string; execute: (...args: unknown[]) => Promise<unknown> }>();
  return {
    tools,
    registerTool(def: { name: string; description: string; execute: (...args: unknown[]) => Promise<unknown> }) {
      tools.set(def.name, def);
    },
  };
}

const entries: McpToolSnapshotEntry[] = [
  { serverName: "GitHub", nativeName: "list-issues", description: "List issues", inputSchema: { type: "object", properties: { repo: { type: "string" } } } },
  { serverName: "GitHub", nativeName: "list issues", description: "Same normalized name", inputSchema: { type: "object" } },
];

test("McpToolExposer registers each discovered tool with valid schema and stable names", () => {
  const pi = fakePi();
  const exposer = new McpToolExposer(pi as never, { reservedToolNames: ["read", "bash"] });
  const result = exposer.sync(entries, 1);
  assert.equal(result.added.length, 2);
  assert.equal(pi.tools.size, 2);
  const names = [...pi.tools.keys()];
  assert.ok(names.includes("github_list_issues"));
  assert.ok(names.some((name) => /^github_list_issues_[0-9a-f]{8}$/.test(name)));
  assert.ok([...pi.tools.values()].every((tool) => tool.description.length > 0));
});

test("McpToolExposer routes invocation through the original server and native name", async () => {
  const pi = fakePi();
  const exposer = new McpToolExposer(pi as never);
  const calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [];
  exposer.setInvokeHandler(async (mapping, args) => {
    calls.push({ server: mapping.serverName, tool: mapping.nativeName, args });
    return { content: [{ type: "text", text: "ok" }], details: { server: mapping.serverName, tool: mapping.nativeName } } as never;
  });
  exposer.sync([{ serverName: "server", nativeName: "native-tool", inputSchema: { type: "object" } }], 1);
  const registered = [...pi.tools.values()][0]!;
  await registered.execute("call-1", { answer: 42 }, undefined, undefined, { cwd: "/tmp" });
  assert.deepEqual(calls, [{ server: "server", tool: "native-tool", args: { answer: 42 } }]);
});

test("refresh updates current bindings and removed definitions become unavailable", async () => {
  const pi = fakePi();
  const calls: number[] = [];
  const exposer = new McpToolExposer(pi as never);
  exposer.setInvokeHandler(async (mapping) => {
    calls.push(mapping.revision);
    if (mapping.nativeName === "new") {
      return { content: [{ type: "text", text: "new-binding" }], details: {} } as never;
    }
    return { content: [{ type: "text", text: "old-binding" }], details: {} } as never;
  });
  const name = "server_tool";
  exposer.sync([{ serverName: "server", nativeName: "tool", description: "v1" }], 1);
  const firstDef = pi.tools.get(name)!;
  // Refresh the same native identity: the stable Pi name is kept.
  const result = exposer.sync([{ serverName: "server", nativeName: "tool", description: "v2" }], 2);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.updated, [name]);
  assert.ok(pi.tools.has(name), "stable registered name is preserved");
  const secondDef = pi.tools.get(name)!;
  assert.match(secondDef.description, /v2/);
  // Execution now routes through the newest binding (revision 2).
  await secondDef.execute("call", {}, undefined, undefined, { cwd: "/tmp" });
  assert.deepEqual(calls, [2]);
  const firstResult = await firstDef.execute("call", {}, undefined, undefined, { cwd: "/tmp" });
  assert.deepEqual(calls, [2, 2], "the old tool call also resolves the current binding");
  void firstResult;
  // Removing the tool no longer routes successfully.
  exposer.sync([], 3);
  assert.equal(exposer.mapping(name), undefined);
});
