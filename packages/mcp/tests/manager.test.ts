import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createMcpManager, projectConfigPath, userConfigPath } from "../src/index.ts";

async function startRecoveryFixture(): Promise<{ url: string; server: Server; calls: () => number }> {
  let callCount = 0;
  let sessionCount = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; method: string };
    const session = String(req.headers["mcp-session-id"] ?? `recovery-${++sessionCount}`);
    const send = (payload: unknown, status = 200): void => {
      res.writeHead(status, { "Content-Type": "application/json", "Mcp-Session-Id": session });
      res.end(JSON.stringify(payload));
    };
    if (body.method === "initialize") {
      send({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "recovery", version: "1" } } });
    } else if (body.method === "tools/list") {
      send({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "recoverable", inputSchema: { type: "object" } }] } });
    } else if (body.method === "tools/call") {
      callCount += 1;
      if (callCount === 1) send({ jsonrpc: "2.0", id: body.id, error: { code: -32001, message: "session expired" } });
      else send({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "recovered" }] } });
    } else {
      send({ jsonrpc: "2.0", id: body.id, result: {} });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/mcp`, server, calls: () => callCount };
}

test("explicit reload reconciliation keeps active server status and removes removed connections", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-mcp-reconcile-"));
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  const fixture = new URL("./fixtures/stdio-server.ts", import.meta.url).pathname;
  const fixtureCwd = dirname(fixture);
  writeFileSync(userConfigPath(agentDir), JSON.stringify({ mcp: { servers: {
    fixture: { type: "local", command: [process.execPath, fixture], cwd: fixtureCwd },
  } } }));
  const manager = createMcpManager({ agentDir, projectRoot });
  await manager.start();
  assert.equal(manager.status("fixture")?.status, "connected");
  writeFileSync(userConfigPath(agentDir), JSON.stringify({ mcp: { servers: {} } }));
  manager.reload();
  await manager.reconcile();
  assert.equal(manager.status("fixture"), undefined);
  assert.deepEqual(manager.serverNames(), []);
  await manager.stop();
  rmSync(root, { recursive: true, force: true });
});

test("manager start/stop is deterministic, idempotent, and wires an injected watcher", async () => {
  const agentDir = join(mkdtempSync(join(tmpdir(), "pi-code-mcp-mgr-agent-")), "agent");
  const projectRoot = join(mkdtempSync(join(tmpdir(), "pi-code-mcp-mgr-")), "project");
  mkdirSync(join(projectRoot, ".pi"), { recursive: true });
  writeFileSync(
    join(projectRoot, ".pi", "mcp.json"),
    `{"mcp":{"servers":{"s":{"type":"local","command":["node","x.js"],"disabled":true}}}}`,
  );

  const watched: string[][] = [];
  let unsubscribeCount = 0;
  const manager = createMcpManager({
    agentDir,
    projectRoot,
    watch(paths) {
      watched.push([...paths]);
      return () => {
        unsubscribeCount += 1;
      };
    },
  });

  const start1 = await manager.start();
  assert.equal(start1.running, true);
  assert.deepEqual(start1.servers.s, { status: "disabled", errorCategory: "none" });
  assert.equal(manager.state().running, true);
  assert.deepEqual(watched, [[userConfigPath(agentDir), projectConfigPath(projectRoot)]]);

  // start is idempotent: the watcher is not registered twice.
  await manager.start();
  assert.equal(unsubscribeCount, 0);

  await manager.stop();
  assert.equal(unsubscribeCount, 1);
  assert.equal(manager.state().running, false);

  // stop is idempotent.
  await manager.stop();
  assert.equal(unsubscribeCount, 1);

  rmSync(agentDir, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

test("watched configuration changes debounce and reconcile only affected servers", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-mcp-watch-"));
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  const fixture = new URL("./fixtures/stdio-server.ts", import.meta.url).pathname;
  const fixtureCwd = dirname(fixture);
  writeFileSync(userConfigPath(agentDir), JSON.stringify({ mcp: { servers: {
    first: { type: "local", command: [process.execPath, fixture], cwd: fixtureCwd },
    second: { type: "local", command: [process.execPath, fixture], cwd: fixtureCwd },
  } } }));
  let trigger: (() => void) | undefined;
  let resolveChanged: (() => void) | undefined;
  const changed: string[][] = [];
  const manager = createMcpManager({
    agentDir,
    projectRoot,
    reloadDebounceMs: 20,
    watch: (_paths, onChange) => { trigger = onChange; return () => undefined; },
    onConfigChanged: (names) => {
      changed.push(names);
      resolveChanged?.();
    },
  });
  try {
    await manager.start();
    writeFileSync(userConfigPath(agentDir), JSON.stringify({ mcp: { servers: {
      first: { type: "local", command: [process.execPath, fixture], cwd: fixtureCwd, disabled: true },
      second: { type: "local", command: [process.execPath, fixture], cwd: fixtureCwd },
    } } }));
    const settled = new Promise<void>((resolve) => { resolveChanged = resolve; });
    trigger?.();
    trigger?.();
    await settled;
    assert.deepEqual(manager.status("first"), { status: "disabled", errorCategory: "none" });
    assert.equal(manager.status("second")?.status, "connected");
    assert.deepEqual(changed, [["first"]]);
  } finally {
    await manager.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("connection close marks a server failed and reconnects with bounded backoff", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-mcp-reconnect-"));
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  const fixture = new URL("./fixtures/stdio-server.ts", import.meta.url).pathname;
  const exitOnce = join(root, "exit-once");
  const statuses: string[] = [];
  writeFileSync(userConfigPath(agentDir), JSON.stringify({ mcp: { servers: {
    reconnect: { type: "local", command: [process.execPath, fixture], cwd: dirname(fixture), environment: {
      MCP_FIXTURE_EXIT_ONCE_FILE: exitOnce,
      MCP_FIXTURE_EXIT_AFTER_MS: "100",
    } },
  } } }));
  const manager = createMcpManager({
    agentDir,
    projectRoot,
    reconnectBaseDelayMs: 20,
    reconnectMaxAttempts: 3,
    onServerChanged: (name) => statuses.push(manager.status(name)?.status ?? "missing"),
  });
  try {
    await manager.start();
    assert.equal(manager.status("reconnect")?.status, "connected");
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(manager.status("reconnect")?.status, "connected");
    assert.ok(statuses.includes("failed"), "close reports a failed transition");
  } finally {
    await manager.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote session expiration reinitializes once and retries the request", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-mcp-session-recovery-"));
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  const fixture = await startRecoveryFixture();
  writeFileSync(userConfigPath(agentDir), JSON.stringify({ mcp: { servers: {
    recovery: { type: "remote", url: fixture.url, oauth: false },
  } } }));
  const manager = createMcpManager({ agentDir, projectRoot });
  try {
    await manager.start();
    const result = await manager.callTool("recovery", "recoverable", {});
    assert.equal(result.content?.[0]?.type, "text");
    assert.equal((result.content?.[0] as { text?: string }).text, "recovered");
    assert.equal(fixture.calls(), 2);
  } finally {
    await manager.stop();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("manager reload updates state and invokes the reload callback", async () => {
  const agentDir = join(mkdtempSync(join(tmpdir(), "pi-code-mcp-mgr2-agent-")), "agent");
  const projectRoot = join(mkdtempSync(join(tmpdir(), "pi-code-mcp-mgr2-")), "project");
  mkdirSync(join(projectRoot, ".pi"), { recursive: true });
  writeFileSync(join(projectRoot, ".pi", "mcp.json"), `{"mcp":{"servers":{"a":{"type":"local","command":["n","a"]}}}}`);

  let reloaded = 0;
  const manager = createMcpManager({
    agentDir,
    projectRoot,
    onReload() {
      reloaded += 1;
    },
  });
  const result = manager.reload();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(Object.keys(result.value.servers), ["a"]);
  assert.equal(reloaded, 1);
  assert.equal(manager.state().running, false);

  rmSync(agentDir, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});
