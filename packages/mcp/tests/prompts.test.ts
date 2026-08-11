import assert from "node:assert/strict";
import { test } from "node:test";
import {
  McpPromptsResourcesExposer,
  normalizePromptResult,
  normalizeResourceResult,
  promptResultToText,
  resourceResultToText,
} from "../src/index.ts";

function fakePi() {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  const sent: string[] = [];
  return {
    commands,
    tools,
    sent,
    registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, def); },
    registerTool(def: { name: string; execute: (...args: any[]) => Promise<any> }) { tools.set(def.name, def); },
    sendUserMessage(text: string) { sent.push(text); },
  };
}

const manager = {
  serverNames: () => ["demo"],
  promptsFor: (name: string) => name === "demo" ? [{ name: "greet", description: "Greets", arguments: [{ name: "who", required: true }] }] : [],
};

test("prompt normalization preserves roles and bounds text", () => {
  const result = normalizePromptResult("demo", "greet", {
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "world" }] },
    ],
  });
  assert.deepEqual(result.messages, [
    { role: "user", text: "hello" },
    { role: "assistant", text: "world" },
  ]);
  assert.match(promptResultToText(result), /user: hello/);
});

test("resource normalization preserves text and clearly omits binary content", () => {
  const result = normalizeResourceResult("demo", "file:///x", {
    contents: [
      { uri: "file:///x", mimeType: "text/plain", text: "hello" },
      { uri: "file:///blob", mimeType: "application/octet-stream", blob: "aGVsbG8=" },
    ],
  });
  assert.equal(result.text.includes("hello"), true);
  assert.equal(result.omitted?.includes("file:///blob"), true);
  assert.match(resourceResultToText(result), /hello/);
});

test("prompt commands are server-scoped, parse JSON arguments, and send normal user output", async () => {
  const pi = fakePi();
  const calls: Array<{ server: string; prompt: string; args: Record<string, string> }> = [];
  const exposer = new McpPromptsResourcesExposer(pi as never);
  exposer.register(
    manager,
    async (server, prompt, args) => {
      calls.push({ server, prompt, args });
      return normalizePromptResult(server, prompt, { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] });
    },
    async (_server, uri) => normalizeResourceResult("demo", uri, { contents: [{ uri, text: "resource" }] }),
    () => [],
  );
  const command = [...pi.commands.entries()].find(([name]) => name.startsWith("mcp_prompt_demo_greet"));
  assert.ok(command);
  await command[1].handler('{"who":"Pi"}', { hasUI: false, ui: {}, cwd: "/tmp", sessionManager: { getSessionId: () => "s" } });
  assert.deepEqual(calls, [{ server: "demo", prompt: "greet", args: { who: "Pi" } }]);
  assert.match(pi.sent[0] ?? "", /user: hello/);
});

test("resource list/read tools use current accessors and authorization", async () => {
  const pi = fakePi();
  const reads: string[] = [];
  const exposer = new McpPromptsResourcesExposer(pi as never, { authorize: (kind, server, name) => kind === "resource" && server === "demo" && name !== "denied" });
  exposer.register(
    manager,
    async () => normalizePromptResult("demo", "greet", { messages: [] }),
    async (server, uri) => { reads.push(`${server}:${uri}`); return normalizeResourceResult(server, uri, { contents: [{ uri, text: "ok" }] }); },
    (server) => server === "demo" ? [{ uri: "file:///ok", name: "ok" }] : [],
  );
  const list = pi.tools.get("mcp_resources_list")!;
  const read = pi.tools.get("mcp_resources_read")!;
  const listed = await list.execute("id", { server: "demo" }, undefined, undefined, {});
  assert.match(listed.content[0].text, /file:\/\/\/ok/);
  const denied = await read.execute("id", { server: "demo", uri: "denied" }, undefined, undefined, {});
  assert.match(denied.content[0].text, /denied/);
  const result = await read.execute("id", { server: "demo", uri: "file:///ok" }, undefined, undefined, {});
  assert.deepEqual(reads, ["demo:file:///ok"]);
  assert.equal(result.content[0].text, "ok");
});

test("removed prompt commands become unavailable instead of calling stale access", async () => {
  const pi = fakePi();
  let calls = 0;
  const exposer = new McpPromptsResourcesExposer(pi as never);
  exposer.register(manager, async () => { calls += 1; return normalizePromptResult("demo", "greet", { messages: [] }); }, async () => normalizeResourceResult("demo", "x", { contents: [] }), () => []);
  const command = [...pi.commands.values()][0]!;
  exposer.syncPrompts({ serverNames: () => [], promptsFor: () => [] }, async () => { calls += 1; return normalizePromptResult("demo", "greet", { messages: [] }); });
  await command.handler("", { hasUI: false, ui: {}, cwd: "/tmp", sessionManager: { getSessionId: () => "s" } });
  assert.equal(calls, 0);
  assert.match(pi.sent[0] ?? "", /no longer available/);
});
