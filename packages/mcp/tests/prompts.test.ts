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
      { role: "user", content: { type: "text", text: "hello" } },
      { role: "assistant", content: { type: "text", text: "world" } },
    ],
  });
  assert.deepEqual(result.messages, [
    { role: "user", text: "hello" },
    { role: "assistant", text: "world" },
  ]);
  assert.match(promptResultToText(result), /user: hello/);
});

test("resource normalization preserves text, adapts images, and omits unsupported binary content", () => {
  const result = normalizeResourceResult("demo", "file:///x", {
    contents: [
      { uri: "file:///x", mimeType: "text/plain", text: "hello" },
      { uri: "file:///image", mimeType: "image/png", blob: "aGVsbG8=" },
      { uri: "file:///blob", mimeType: "application/octet-stream", blob: "aGVsbG8=" },
    ],
  });
  assert.equal(result.text.includes("hello"), true);
  assert.equal(result.content?.some((item) => item.type === "image" && item.mimeType === "image/png"), true);
  assert.equal(result.omitted?.includes("file:///blob"), true);
  assert.match(resourceResultToText(result), /hello/);
});

test("resource normalization omits oversized images and bounds aggregate text", () => {
  const result = normalizeResourceResult("demo", "file:///large", {
    contents: [
      { uri: "file:///a", mimeType: "text/plain", text: "a".repeat(40_000) },
      { uri: "file:///b", mimeType: "text/plain", text: "b".repeat(40_000) },
      { uri: "file:///large.png", mimeType: "image/png", blob: "a".repeat(8 * 1024 * 1024) },
    ],
  });
  assert.ok(result.text.length <= 50_000, "aggregate text is hard bounded");
  assert.match(result.text, /image omitted|output truncated/);
  assert.equal(result.omitted?.includes("file:///large.png"), true);
});

test("resource normalization emits only one truncation marker after many post-limit blocks", () => {
  const result = normalizeResourceResult("demo", "file:///many", {
    contents: Array.from({ length: 100 }, (_, index) => ({
      uri: `file:///text-${index}`,
      mimeType: "text/plain",
      text: "x".repeat(10_000),
    })),
  });
  assert.ok(result.text.length <= 50_000, "many blocks remain hard bounded");
  assert.equal((result.text.match(/output truncated/g) ?? []).length, 1);
});

test("prompt commands are server-scoped, parse JSON arguments, pass abort signals, and send normal user output", async () => {
  const pi = fakePi();
  const calls: Array<{ server: string; prompt: string; args: Record<string, string>; signal?: AbortSignal }> = [];
  const exposer = new McpPromptsResourcesExposer(pi as never);
  exposer.register(
    manager,
    async (server, prompt, args, signal) => {
      calls.push({ server, prompt, args, signal });
      return normalizePromptResult(server, prompt, { messages: [{ role: "user", content: { type: "text", text: "hello" } }] });
    },
    async (_server, uri) => normalizeResourceResult("demo", uri, { contents: [{ uri, text: "resource" }] }),
    () => [],
  );
  const command = [...pi.commands.entries()].find(([name]) => name.startsWith("mcp_prompt_demo_greet"));
  assert.ok(command);
  const controller = new AbortController();
  await command[1].handler('{"who":"Pi"}', { hasUI: true, ui: { notify() {} }, cwd: "/tmp", signal: controller.signal, sessionManager: { getSessionId: () => "s" } });
  assert.equal(calls[0]?.signal, controller.signal);
  assert.deepEqual(calls.map(({ server, prompt, args }) => ({ server, prompt, args })), [{ server: "demo", prompt: "greet", args: { who: "Pi" } }]);
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

test("resource read tool emits one bounded text stream including omission messages", async () => {
  const pi = fakePi();
  const exposer = new McpPromptsResourcesExposer(pi as never);
  exposer.register(manager, async () => normalizePromptResult("demo", "greet", { messages: [] }), async (_server, uri) => normalizeResourceResult("demo", uri, {
    contents: [
      { uri: "file:///a", text: "a".repeat(40_000) },
      { uri: "file:///b", text: "b".repeat(40_000) },
      { uri: "file:///blob", mimeType: "application/octet-stream", blob: "aGVsbG8=" },
    ],
  }), () => []);
  const result = await pi.tools.get("mcp_resources_read")!.execute("id", { server: "demo", uri: "file:///a" }, undefined, undefined, {});
  assert.ok(result.content[0].text.length <= 50_050);
  assert.match(result.content[0].text, /binary resource omitted|output truncated/);
  assert.equal(result.content.length, 1);
});

test("prompt identity command names remain stable when catalog order changes", async () => {
  const pi = fakePi();
  const calls: string[] = [];
  const first = { serverNames: () => ["demo"], promptsFor: () => [{ name: "a-b" }, { name: "a b" }] };
  const second = { serverNames: () => ["demo"], promptsFor: () => [{ name: "a b" }, { name: "a-b" }] };
  const exposer = new McpPromptsResourcesExposer(pi as never);
  const readPrompt = async (_server: string, prompt: string) => {
    calls.push(prompt);
    return normalizePromptResult("demo", prompt, { messages: [{ role: "user", content: { type: "text", text: prompt } }] });
  };
  exposer.register(first, readPrompt, async () => normalizeResourceResult("demo", "x", { contents: [] }), () => []);
  const names = [...pi.commands.keys()];
  exposer.syncPrompts(second, readPrompt);
  for (const name of names) {
    await pi.commands.get(name)!.handler("", { hasUI: false, ui: {}, cwd: "/tmp", signal: undefined, sessionManager: { getSessionId: () => "s" } });
  }
  assert.deepEqual(calls.sort(), ["a b", "a-b"].sort());
});

test("disconnected prompt and resource access produce explicit unavailable results", async () => {
  const prompt = normalizePromptResult("demo", "greet", undefined, { unavailable: true });
  assert.match(promptResultToText(prompt), /unavailable/);
  const resource = normalizeResourceResult("demo", "file:///gone", undefined, { unavailable: true });
  assert.match(resourceResultToText(resource), /unavailable/);
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
