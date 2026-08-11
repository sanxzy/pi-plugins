import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerMcpLifecycle } from "../src/index.ts";
import { userConfigPath, createDefaultAuthStore } from "../src/index.ts";

interface HandlerMap {
  handlers: Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>;
}

function fakePi(): HandlerMap & {
  on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void): void;
  registerCommand(name: string, def: { description: string; handler(args: string, ctx: unknown): Promise<void> | void }): void;
  commands: Map<string, { description: string; handler(args: string, ctx: unknown): Promise<void> | void }>;
} {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
  const commands = new Map<string, { description: string; handler(args: string, ctx: unknown): Promise<void> | void }>();
  return {
    handlers,
    commands,
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, def) {
      commands.set(name, def);
    },
  };
}

function context(cwd: string, sessionId: string) {
  return {
    cwd,
    sessionManager: { getSessionId: () => sessionId },
  };
}

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
  mkdirSync(agentDir, { recursive: true });
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
  mkdirSync(agentDir, { recursive: true });
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
