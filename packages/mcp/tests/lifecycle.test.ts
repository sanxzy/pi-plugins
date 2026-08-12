import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerMcpLifecycle } from "../src/index.ts";
import { userConfigPath, projectConfigPath, createDefaultAuthStore } from "../src/index.ts";
import { publishSessionMcpBridge, clearSessionMcpBridge } from "@xzy-ai/core";
import { dirname } from "node:path";

const fixture = new URL("./fixtures/stdio-server.ts", import.meta.url).pathname;
const fixtureCwd = dirname(fixture);

interface HandlerMap {
  handlers: Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>;
  tools: Map<string, { name: string; execute: (...args: unknown[]) => Promise<unknown> }>;
}

function fakePi(): HandlerMap & {
  on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void): void;
  registerCommand(name: string, def: { description: string; handler(args: string, ctx: unknown): Promise<void> | void }): void;
  registerTool(def: { name: string; execute?: (...args: unknown[]) => Promise<unknown> }): void;
  commands: Map<string, { description: string; handler(args: string, ctx: unknown): Promise<void> | void }>;
} {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
  const commands = new Map<string, { description: string; handler(args: string, ctx: unknown): Promise<void> | void }>();
  const tools = new Map<string, { name: string; execute: (...args: unknown[]) => Promise<unknown> }>();
  return {
    handlers,
    commands,
    tools,
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, def) {
      commands.set(name, def);
    },
    registerTool(def) {
      if (def.execute) tools.set(def.name, { name: def.name, execute: def.execute });
    },
  };
}

function context(cwd: string, sessionId: string) {
  return {
    cwd,
    sessionManager: { getSessionId: () => sessionId },
  };
}

test("simultaneous sessions expose isolated MCP managers and shared tool bindings", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-mcp-phase8-isolation-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "pi-code"), { recursive: true });
  mkdirSync(join(first, ".pi"), { recursive: true });
  mkdirSync(join(second, ".pi"), { recursive: true });
  writeFileSync(projectConfigPath(first), JSON.stringify({ mcp: { servers: { first: { type: "local", command: [process.execPath, fixture], cwd: fixtureCwd, environment: { MCP_FIXTURE_LABEL: "first", MCP_FIXTURE_MODE: "policy" } } } } }));
  writeFileSync(projectConfigPath(second), JSON.stringify({ mcp: { servers: { second: { type: "local", command: [process.execPath, fixture], cwd: fixtureCwd, environment: { MCP_FIXTURE_LABEL: "second", MCP_FIXTURE_MODE: "policy" } } } } }));
  const pi = fakePi();
  const realPi = { ...pi, sendUserMessage() {}, getAllTools() { return [...pi.tools.values()].map((tool) => ({ name: tool.name })); }, getActiveTools() { return []; }, setActiveTools() {} };
  registerMcpLifecycle(realPi as never, { agentDir });
  const start = pi.handlers.get("session_start")!;
  const shutdown = pi.handlers.get("session_shutdown")!;
  const firstCtx = { ...context(first, "first-session"), hasUI: false, ui: {} };
  const secondCtx = { ...context(second, "second-session"), hasUI: false, ui: {} };
  try {
    await start({ reason: "startup" }, firstCtx);
    await start({ reason: "startup" }, secondCtx);
    assert.ok(pi.tools.has("first_protected_read"));
    assert.ok(pi.tools.has("second_protected_read"));
    const firstResult = await pi.tools.get("first_allowed_read")!.execute("first", { value: "one" }, undefined, undefined, firstCtx) as { content: Array<{ text: string }> };
    const secondResult = await pi.tools.get("second_protected_read")!.execute("second", { value: "two" }, undefined, undefined, secondCtx) as { content: Array<{ text: string }> };
    assert.match(firstResult.content[0]?.text ?? "", /allowed_read:one/);
    assert.match(secondResult.content[0]?.text ?? "", /protected_read:two/);
    const prompt = pi.commands.get("mcp_prompt_second_allowed_prompt")!;
    await prompt.handler('{"value":"two"}', secondCtx);
    const listed = await pi.tools.get("mcp_resources_list")!.execute("second", { server: "second" }, undefined, undefined, secondCtx) as { content: Array<{ text: string }> };
    assert.match(listed.content[0]?.text ?? "", /file:\/\/\/allowed/);
    await shutdown({ reason: "quit" }, firstCtx);
    const stillUsable = await pi.tools.get("second_allowed_read")!.execute("second", { value: "after" }, undefined, undefined, secondCtx) as { content: Array<{ text: string }> };
    assert.match(stillUsable.content[0]?.text ?? "", /allowed_read/);
  } finally {
    await shutdown({ reason: "quit" }, firstCtx);
    await shutdown({ reason: "quit" }, secondCtx);
    rmSync(root, { recursive: true, force: true });
  }
});

test("registerMcpLifecycle starts isolated managers for each session and stops them", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-mcp-lifecycle-"));
  const agentDir = join(root, "agent");
  const firstProject = join(root, "first");
  const secondProject = join(root, "second");
  const pi = fakePi();
  let watchers = 0;
  let unsubscribes = 0;

  registerMcpLifecycle(pi as never, {
    agentDir,
    watch() {
      watchers += 1;
      return () => {
        unsubscribes += 1;
      };
    },
  });

  const start = pi.handlers.get("session_start")!;
  const shutdown = pi.handlers.get("session_shutdown")!;
  await start({ reason: "startup" }, context(firstProject, "session-a"));
  await start({ reason: "startup" }, context(secondProject, "session-a"));
  assert.equal(watchers, 2);

  await shutdown({ reason: "quit" }, context(firstProject, "session-a"));
  assert.equal(unsubscribes, 1);
  await shutdown({ reason: "quit" }, context(secondProject, "session-a"));
  assert.equal(unsubscribes, 2);

  rmSync(root, { recursive: true, force: true });
});

test("repeated session start does not create a second manager for the same session", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-mcp-lifecycle-repeat-"));
  const pi = fakePi();
  let watchers = 0;
  registerMcpLifecycle(pi as never, {
    agentDir: join(root, "agent"),
    watch() {
      watchers += 1;
      return () => undefined;
    },
  });

  const ctx = context(join(root, "project"), "same-session");
  await pi.handlers.get("session_start")!({ reason: "startup" }, ctx);
  await pi.handlers.get("session_start")!({ reason: "reload" }, ctx);
  assert.equal(watchers, 1);

  await pi.handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
  rmSync(root, { recursive: true, force: true });
});

test("registerMcpLifecycle exposes an /mcp command that reports status and handles logout", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-mcp-cmd-"));
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "pi-code"), { recursive: true });
  writeFileSync(
    userConfigPath(agentDir),
    JSON.stringify({
      mcp: {
        servers: {
          remote: { type: "remote", url: "http://127.0.0.1:9/mcp", oauth: false },
        },
      },
    }),
  );
  const pi = fakePi();
  const sent: string[] = [];
  const realPi = {
    ...pi,
    sendUserMessage: (content: string) => {
      sent.push(content);
    },
  };
  registerMcpLifecycle(realPi as never, { agentDir });

  const startup = pi.handlers.get("session_start")!;
  const shutdown = pi.handlers.get("session_shutdown")!;
  const cmdHandler = pi.commands.get("mcp")?.handler;
  assert.ok(cmdHandler, "/mcp command is registered");

  const noUiCtx = { ...context(join(root, "project"), "session-c"), hasUI: false, ui: {} };
  await startup({ reason: "startup" }, noUiCtx);
  await cmdHandler("status", noUiCtx);
  assert.ok(
    sent.some((line) => line.includes("remote") && (line.includes("failed") || line.includes("configured"))),
    "status reports the remote server state",
  );

  await cmdHandler("logout remote", noUiCtx);
  assert.ok(sent.some((line) => line.toLowerCase().includes("logged out")), "logout reports completion");

  await shutdown({ reason: "quit" }, noUiCtx);
  rmSync(root, { recursive: true, force: true });
});

test("/mcp logout closes the active transport before clearing credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-mcp-cmd-logout-"));
  const agentDir = join(root, "agent");
  let sessions = 0;
  // A minimal streamable fixture that counts initialize sessions.
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; method: string };
    res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": `s${sessions}` });
    if (body.method === "initialize") {
      sessions += 1;
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {
        protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "cmd-fixture", version: "1" },
      } }));
      return;
    }
    if (body.method === "tools/list") {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "cmd_tool", inputSchema: { type: "object" } }] } }));
      return;
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  mkdirSync(join(agentDir, "pi-code"), { recursive: true });
  writeFileSync(userConfigPath(agentDir), JSON.stringify({ mcp: { servers: {
    remote: { type: "remote", url, oauth: false },
  } } }));
  const pi = fakePi();
  const sent: string[] = [];
  const realPi = { ...pi, sendUserMessage: (content: string) => { sent.push(content); } };
  registerMcpLifecycle(realPi as never, { agentDir });
  const startup = pi.handlers.get("session_start")!;
  const shutdown = pi.handlers.get("session_shutdown")!;
  const cmdHandler = pi.commands.get("mcp")?.handler;
  assert.ok(cmdHandler);
  const noUiCtx = { ...context(join(root, "project"), "cls"), hasUI: false, ui: {} };
  try {
    await startup({ reason: "startup" }, noUiCtx);
    await cmdHandler("status", noUiCtx);
    assert.ok(sent.some((line) => line.includes("remote") && line.includes("connected")), "connected before logout");
    await cmdHandler("logout remote", noUiCtx);
    assert.ok(sent.some((line) => line.toLowerCase().includes("logged out")), "logout reports completion");
    await cmdHandler("status", noUiCtx);
    assert.ok(sent.some((line) => line.includes("remote") && !line.includes("connected")), "transport closed after logout");
  } finally {
    await shutdown({ reason: "quit" }, noUiCtx);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("/mcp control-plane subcommands operate without adding tools and use bounded errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-mcp-cmd-plane-"));
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "pi-code"), { recursive: true });
  writeFileSync(userConfigPath(agentDir), JSON.stringify({ mcp: { servers: {
    remote: { type: "remote", url: "http://127.0.0.1:9/mcp", oauth: false },
  } } }));
  const pi = fakePi();
  const sent: string[] = [];
  const realPi = { ...pi, sendUserMessage: (content: string) => { sent.push(content); } };
  const toolRegistrations: string[] = [];
  const trackingPi = {
    ...realPi,
    registerTool(def: { name: string }) { toolRegistrations.push(def.name); },
  };
  registerMcpLifecycle(trackingPi as never, { agentDir });
  const startup = pi.handlers.get("session_start")!;
  const shutdown = pi.handlers.get("session_shutdown")!;
  const cmdHandler = pi.commands.get("mcp")?.handler;
  assert.ok(cmdHandler);
  const noUiCtx = { ...context(join(root, "project"), "plane"), hasUI: false, ui: {} };
  try {
    await startup({ reason: "startup" }, noUiCtx);
    await cmdHandler("list", noUiCtx);
    assert.ok(sent.some((line) => line.includes("remote") && line.includes("tools=")), "list reports tool counts");
    await cmdHandler("disconnect unknown-server", noUiCtx);
    assert.ok(sent.some((line) => line.includes("unknown server")), "unknown disconnect is rejected");
    await cmdHandler("disconnect remote", noUiCtx);
    await cmdHandler("reload", noUiCtx);
    assert.ok(sent.some((line) => line.toLowerCase().includes("reloaded")), "reload reports completion");
    await cmdHandler("debug", noUiCtx);
    assert.ok(sent.some((line) => line.startsWith("MCP debug")), "debug reports server state");
    await cmdHandler("does-not-exist", noUiCtx);
    assert.ok(sent.some((line) => line.includes("unknown subcommand")), "unknown subcommand is bounded");
    // Control-plane actions must not add MCP management tools to the catalog.
    assert.equal(toolRegistrations.includes("mcp_connect"), false);
  } finally {
    await shutdown({ reason: "quit" }, noUiCtx);
    rmSync(root, { recursive: true, force: true });
  }
});

test("timer reconnect reactivates recovered MCP tools in the lifecycle", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-mcp-lifecycle-reconnect-"));
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  mkdirSync(join(agentDir, "pi-code"), { recursive: true });
  const exitOnce = join(root, "exit-once");
  writeFileSync(userConfigPath(agentDir), JSON.stringify({ mcp: { servers: {
    reconnect: { type: "local", command: [process.execPath, fixture], cwd: fixtureCwd, environment: {
      MCP_FIXTURE_EXIT_ONCE_FILE: exitOnce,
      MCP_FIXTURE_EXIT_AFTER_MS: "100",
    } },
  } } }));
  const pi = fakePi();
  const activeSnapshots: string[][] = [];
  const realPi = {
    ...pi,
    setActiveTools(names: string[]) { activeSnapshots.push([...names]); },
    getActiveTools() { return activeSnapshots.at(-1) ?? []; },
    getAllTools() { return [...pi.tools.values()].map((tool) => ({ name: tool.name })); },
    sendUserMessage() {},
  };
  registerMcpLifecycle(realPi as never, { agentDir });
  const ctx = { ...context(projectRoot, "reconnect-session"), hasUI: false, ui: {} };
  const start = pi.handlers.get("session_start")!;
  const shutdown = pi.handlers.get("session_shutdown")!;
  try {
    await start({ reason: "startup" }, ctx);
    const toolName = "reconnect_current_directory";
    assert.ok(activeSnapshots.some((names) => names.includes(toolName)));
    const failedDeadline = Date.now() + 3_000;
    while (Date.now() < failedDeadline && !activeSnapshots.some((names) => !names.includes(toolName))) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.ok(activeSnapshots.some((names) => !names.includes(toolName)), "failed server deactivates its tool");
    const recoveredDeadline = Date.now() + 3_000;
    while (Date.now() < recoveredDeadline && activeSnapshots.at(-1)?.includes(toolName) !== true) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(activeSnapshots.at(-1)?.includes(toolName), true, "reconnect reactivates recovered tool");
  } finally {
    await shutdown({ reason: "quit" }, ctx);
    rmSync(root, { recursive: true, force: true });
  }
});

test("lifecycle enforces allow/deny/ask policy for tools, prompts, and resources", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-mcp-policy-lifecycle-"));
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  mkdirSync(join(agentDir, "pi-code"), { recursive: true });
  writeFileSync(userConfigPath(agentDir), JSON.stringify({ mcp: { servers: {
    policy: { type: "local", command: [process.execPath, fixture], cwd: fixtureCwd, environment: { MCP_FIXTURE_MODE: "policy" } },
  } } }));
  mkdirSync(join(projectRoot, ".pi"), { recursive: true });
  writeFileSync(join(projectRoot, ".pi", "mcp.json"), JSON.stringify({ mcp: { permissions: {
    tools: [
      { effect: "deny", server: "policy", name: "protected_*" },
      { effect: "allow", server: "policy", name: "allowed_*" },
      { effect: "ask", server: "policy", name: "ask_*" },
    ],
    prompts: [
      { effect: "deny", server: "policy", name: "protected_*" },
      { effect: "allow", server: "policy", name: "allowed_*" },
      { effect: "ask", server: "policy", name: "ask_*" },
    ],
    resources: [
      { effect: "deny", server: "policy", name: "file:///protected" },
      { effect: "allow", server: "policy", name: "file:///allowed" },
      { effect: "ask", server: "policy", name: "file:///ask" },
    ],
  } } }));
  const pi = fakePi();
  const sent: string[] = [];
  const realPi = { ...pi, sendUserMessage: (content: string) => { sent.push(content); } };
  registerMcpLifecycle(realPi as never, { agentDir });
  const start = pi.handlers.get("session_start")!;
  const shutdown = pi.handlers.get("session_shutdown")!;
  const ctxBase = { ...context(projectRoot, "policy-session"), signal: undefined };
  const noUi = { ...ctxBase, hasUI: false, ui: {} };
  try {
    await start({ reason: "startup" }, noUi);
    const statusCommand = pi.commands.get("mcp")?.handler;
    assert.ok(statusCommand);
    await statusCommand("status", noUi);
    assert.ok(sent.some((message) => message.includes("policy") && message.includes("errorCategory=none") && message.includes("mappings=") && message.includes("policy_allowed_read->allowed_read")));
    const allowedTool = pi.tools.get("policy_allowed_read");
    const protectedTool = pi.tools.get("policy_protected_read");
    const askTool = pi.tools.get("policy_ask_read");
    assert.ok(allowedTool && protectedTool && askTool);
    const allowed = await allowedTool.execute("allowed", { value: "ok" }, undefined, undefined, noUi);
    assert.match(String((allowed as { content: Array<{ text: string }> }).content[0]?.text), /tool:allowed_read:ok/);
    const denied = await protectedTool.execute("denied", { value: "blocked" }, undefined, undefined, noUi) as { details: { failure?: string } };
    assert.equal(denied.details.failure, "policy_denied");
    const noUiAsk = await askTool.execute("ask-no-ui", { value: "blocked" }, undefined, undefined, noUi) as { details: { failure?: string } };
    assert.equal(noUiAsk.details.failure, "policy_denied");

    let confirms = 0;
    const approveCtx = { ...ctxBase, hasUI: true, ui: { confirm: async () => { confirms += 1; return true; }, notify() {} } };
    const approved = await askTool.execute("ask-approve", { value: "yes" }, undefined, undefined, approveCtx) as { content: Array<{ text: string }> };
    assert.match(approved.content[0]?.text ?? "", /tool:ask_read:yes/);
    assert.equal(confirms, 1);
    const rejectCtx = { ...ctxBase, hasUI: true, ui: { confirm: async () => false, notify() {} } };
    const rejected = await askTool.execute("ask-reject", { value: "no" }, undefined, undefined, rejectCtx) as { details: { failure?: string } };
    assert.equal(rejected.details.failure, "policy_denied");
    const throwingCtx = { ...ctxBase, hasUI: true, ui: { confirm: async () => { throw new Error("credential=secret"); }, notify() {} } };
    const failedConfirm = await askTool.execute("ask-throw", { value: "no" }, undefined, undefined, throwingCtx) as { details: { failure?: string } };
    assert.equal(failedConfirm.details.failure, "policy_denied");

    const allowedPrompt = pi.commands.get("mcp_prompt_policy_allowed_prompt");
    const protectedPrompt = pi.commands.get("mcp_prompt_policy_protected_prompt");
    const askPrompt = pi.commands.get("mcp_prompt_policy_ask_prompt");
    assert.ok(allowedPrompt && protectedPrompt && askPrompt);
    await allowedPrompt.handler("value=ok", approveCtx);
    assert.ok(sent.some((message) => message.includes("prompt:allowed_prompt:ok")));
    await protectedPrompt.handler("value=blocked", noUi);
    assert.ok(!sent.some((message) => message.includes("prompt:protected_prompt:blocked")), "denied prompt does not reach the server");
    assert.ok(sent.some((message) => /denied by policy/i.test(message)), "denied prompt reports denial");
    await askPrompt.handler("value=blocked", noUi);
    assert.ok(!sent.some((message) => message.includes("prompt:ask_prompt:blocked")), "no-UI ask fails closed");
    await askPrompt.handler("value=approved", approveCtx);
    assert.ok(sent.some((message) => message.includes("prompt:ask_prompt:approved")));

    const readResource = pi.tools.get("mcp_resources_read");
    assert.ok(readResource);
    const allowedResource = await readResource.execute("resource-allow", { server: "policy", uri: "file:///allowed" }, undefined, undefined, noUi) as { content: Array<{ text: string }> };
    assert.match(allowedResource.content[0]?.text ?? "", /resource:file:\/\/\/allowed/);
    const deniedResource = await readResource.execute("resource-deny", { server: "policy", uri: "file:///protected" }, undefined, undefined, noUi) as { details: { denied?: boolean } };
    assert.equal(deniedResource.details.denied, true);
    const noUiResourceAsk = await readResource.execute("resource-ask", { server: "policy", uri: "file:///ask" }, undefined, undefined, noUi) as { details: { denied?: boolean } };
    assert.equal(noUiResourceAsk.details.denied, true);
    const approvedResource = await readResource.execute("resource-approve", { server: "policy", uri: "file:///ask" }, undefined, undefined, approveCtx) as { content: Array<{ text: string }> };
    assert.match(approvedResource.content[0]?.text ?? "", /resource:file:\/\/\/ask/);
  } finally {
    await shutdown({ reason: "quit" }, noUi);
    rmSync(root, { recursive: true, force: true });
  }
});

test("logout removes committed credentials for a remote server", async () => {
  const agentDir = join(mkdtempSync(join(tmpdir(), "pi-code-mcp-logout-")), "agent");
  const store = createDefaultAuthStore(agentDir);
  store.update("https://server.example/mcp", () => ({
    tokens: { accessToken: "stored-token" },
    serverUrl: "https://server.example/mcp",
  }));
  assert.equal(store.getForUrl("https://server.example/mcp")?.tokens?.accessToken, "stored-token");
  const { logoutRemote } = await import("../src/remote.ts");
  logoutRemote({ url: "https://server.example/mcp", agentDir, onRedirect: () => {} });
  assert.equal(store.getForUrl("https://server.example/mcp"), undefined);
  rmSync(agentDir, { recursive: true, force: true });
});

test("child sessions inherit MCP resource access through the bridge without their own authorizer", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-mcp-child-resource-"));
  const projectRoot = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "pi-code"), { recursive: true });
  writeFileSync(userConfigPath(agentDir), JSON.stringify({ mcp: { servers: {
    policy: { type: "local", command: [process.execPath, fixture], cwd: fixtureCwd, environment: { MCP_FIXTURE_MODE: "policy" } },
  } } }));
  mkdirSync(join(projectRoot, ".pi"), { recursive: true });

  const pi = fakePi();
  registerMcpLifecycle(pi as never, { agentDir });
  const start = pi.handlers.get("session_start")!;
  const shutdown = pi.handlers.get("session_shutdown")!;
  const rootCtx = { ...context(projectRoot, "root-session"), signal: undefined, hasUI: false, ui: {} };
  const childCtx = { ...context(projectRoot, "child-session"), signal: undefined, hasUI: false, ui: {} };
  const orphanCtx = { ...context(projectRoot, "orphan-session"), signal: undefined, hasUI: false, ui: {} };
  try {
    await start({ reason: "startup" }, rootCtx);
    // An isolated child publishes an inherited bridge (as createIsolatedChild does).
    const childBridgeCtx = childCtx as unknown as Parameters<typeof publishSessionMcpBridge>[0];
    publishSessionMcpBridge(childBridgeCtx, {
      invokeTool: async () => ({ content: [{ type: "text", text: "bridged" }] }),
      listResources: () => [{ uri: "file:///allowed", name: "allowed" }],
      readResource: async (_s, uri) => ({ uri, text: `resource:${uri}` }),
    });

    const list = pi.tools.get("mcp_resources_list")!;
    const read = pi.tools.get("mcp_resources_read")!;

    // Child with a bridge: resource list/read are authorized, not denied by policy.
    const childListed = await list.execute("id", { server: "policy" }, undefined, undefined, childCtx) as { content: Array<{ text: string }>; details: { denied?: boolean } };
    assert.equal(childListed.details.denied, undefined, "child list is not denied");
    assert.match(childListed.content[0]?.text ?? "", /file:\/\/\/allowed/);
    const childRead = await read.execute("id", { server: "policy", uri: "file:///allowed" }, undefined, undefined, childCtx) as { content: Array<{ text: string }> };
    assert.match(childRead.content[0]?.text ?? "", /resource:file:\/\/\/allowed/);

    // An orphan session with neither an authorizer nor a bridge fails closed.
    const orphanListed = await list.execute("id", { server: "policy" }, undefined, undefined, orphanCtx) as { details: { denied?: boolean } };
    assert.equal(orphanListed.details.denied, true, "orphan child list is denied by policy");
  } finally {
    await shutdown({ reason: "quit" }, rootCtx);
    clearSessionMcpBridge(childCtx as unknown as Parameters<typeof clearSessionMcpBridge>[0]);
    rmSync(root, { recursive: true, force: true });
  }
});
