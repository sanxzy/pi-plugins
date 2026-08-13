import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createSessionLogger, MCP_OPERATIONS, runWithLogContext } from "@xzy-ai/observability";
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
  mkdirSync(join(agentDir, "pi-code"), { recursive: true });
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

test("manager reload, reconnect, close, and stop paths emit dedicated boundaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-mcp-manager-log-"));
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  mkdirSync(join(agentDir, "pi-code"), { recursive: true });
  const fixture = new URL("./fixtures/stdio-server.ts", import.meta.url).pathname;
  const exitOnce = join(root, "exit-once");
  writeFileSync(userConfigPath(agentDir), JSON.stringify({ mcp: { servers: { reconnect: { type: "local", command: [process.execPath, fixture], cwd: dirname(fixture), environment: { MCP_FIXTURE_EXIT_ONCE_FILE: exitOnce, MCP_FIXTURE_EXIT_AFTER_MS: "25" } } } } }));
  const logDir = join(root, "logs");
  const logger = createSessionLogger({ projectId: "project", rootSessionId: "root", eventsPath: join(logDir, "events.jsonl"), errorsPath: join(logDir, "errors.jsonl") });
  const manager = createMcpManager({ agentDir, projectRoot, reconnectBaseDelayMs: 5, reconnectMaxAttempts: 2 });
  await runWithLogContext(logger, async () => {
    manager.reload();
    await manager.start();
    assert.equal(manager.status("reconnect")?.status, "connected");
    const deadline = Date.now() + 3_000;
    let sawFailed = false;
    while (Date.now() < deadline) {
      if (manager.status("reconnect")?.status === "failed") sawFailed = true;
      if (sawFailed && manager.status("reconnect")?.status === "connected") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(sawFailed, true, "reconnect fixture must report a failed transition");
    assert.equal(manager.status("reconnect")?.status, "connected", "reconnect fixture must recover");
    await manager.close();
    await manager.stop();
  });
  const records = readFileSync(join(logDir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const [operation, label] of [[MCP_OPERATIONS.RELOAD, "reload"], [MCP_OPERATIONS.MANAGER_START, "start"], [MCP_OPERATIONS.MANAGER_CLOSE, "close"], [MCP_OPERATIONS.MANAGER_STOP, "stop"], [MCP_OPERATIONS.RECONNECT, "reconnect"]] as const) {
    assert.ok(records.some((record) => record.operation === operation && record.phase === "before"), `missing ${label}`);
  }
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

test("default filesystem watcher reconciles edits in user and project config files", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-mcp-default-watch-"));
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  const projectConfigDir = join(projectRoot, ".pi");
  mkdirSync(join(agentDir, "pi-code"), { recursive: true });
  mkdirSync(projectConfigDir, { recursive: true });
  const fixture = new URL("./fixtures/stdio-server.ts", import.meta.url).pathname;
  const fixtureCwd = dirname(fixture);
  writeFileSync(userConfigPath(agentDir), JSON.stringify({ mcp: { servers: {
    user_server: { type: "local", command: [process.execPath, fixture], cwd: fixtureCwd },
  } } }));
  writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ mcp: { servers: {
    project_server: { type: "local", command: [process.execPath, fixture], cwd: fixtureCwd, disabled: true },
  } } }));
  const changed: string[][] = [];
  const manager = createMcpManager({ agentDir, projectRoot, reloadDebounceMs: 30, onConfigChanged: (names) => changed.push(names) });
  try {
    await manager.start();
    assert.equal(manager.status("user_server")?.status, "connected");
    assert.equal(manager.status("project_server")?.status, "disabled");
    writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ mcp: { servers: {
      project_server: { type: "local", command: [process.execPath, fixture], cwd: fixtureCwd },
    } } }));
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && manager.status("project_server")?.status !== "connected") {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(manager.status("project_server")?.status, "connected");
    assert.ok(changed.some((names) => names.includes("project_server")));
  } finally {
    await manager.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("watched configuration changes debounce and reconcile only affected servers", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-mcp-watch-"));
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  mkdirSync(join(agentDir, "pi-code"), { recursive: true });
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

test("transport errors mark the affected server failed and recover independently", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-mcp-transport-error-"));
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  mkdirSync(join(agentDir, "pi-code"), { recursive: true });
  const fixture = new URL("./fixtures/stdio-server.ts", import.meta.url).pathname;
  const malformed = join(root, "malformed-once");
  const statuses: string[] = [];
  writeFileSync(userConfigPath(agentDir), JSON.stringify({ mcp: { servers: {
    broken: { type: "local", command: [process.execPath, fixture], cwd: dirname(fixture), environment: {
      MCP_FIXTURE_MALFORMED_ONCE_FILE: malformed,
      MCP_FIXTURE_MALFORMED_AFTER_MS: "100",
    } },
  } } }));
  const manager = createMcpManager({ agentDir, projectRoot, reconnectBaseDelayMs: 20, onServerChanged: (name) => statuses.push(manager.status(name)?.status ?? "missing") });
  try {
    await manager.start();
    const failedDeadline = Date.now() + 3_000;
    while (Date.now() < failedDeadline && !statuses.includes("failed")) await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(statuses.includes("failed"), "transport error reports a failed transition");
  } finally {
    await manager.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("connection close marks a server failed and reconnects with bounded backoff", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-mcp-reconnect-"));
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  mkdirSync(join(agentDir, "pi-code"), { recursive: true });
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
    // Wait for the fixture to crash and the manager to record the failed
    // transition before polling for the reconnected state.
    const failedDeadline = Date.now() + 3_000;
    while (Date.now() < failedDeadline && !statuses.includes("failed")) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.ok(statuses.includes("failed"), "close reports a failed transition");
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && manager.status("reconnect")?.status !== "connected") {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(manager.status("reconnect")?.status, "connected");
  } finally {
    await manager.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote session expiration reinitializes once and retries the request", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-mcp-session-recovery-"));
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  mkdirSync(join(agentDir, "pi-code"), { recursive: true });
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

test("close performs full watcher and reconnect cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-mcp-close-cleanup-"));
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  mkdirSync(join(agentDir, "pi-code"), { recursive: true });
  writeFileSync(userConfigPath(agentDir), JSON.stringify({ mcp: { servers: {
    disabled: { type: "local", command: [process.execPath, "unused"], disabled: true },
  } } }));
  let unsubscribed = 0;
  const manager = createMcpManager({ agentDir, projectRoot, watch: () => () => { unsubscribed += 1; } });
  await manager.start();
  await manager.close();
  assert.equal(unsubscribed, 1);
  assert.equal(manager.state().running, false);
  await manager.close();
  assert.equal(unsubscribed, 1);
  rmSync(root, { recursive: true, force: true });
});

test("repeated remote session expiration stays an explicit failed result", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-mcp-session-fail-"));
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  mkdirSync(join(agentDir, "pi-code"), { recursive: true });
  let callCount = 0;
  let sessionCount = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; method: string };
    const session = String(req.headers["mcp-session-id"] ?? `failrec-${++sessionCount}`);
    const send = (payload: unknown, status = 200): void => {
      res.writeHead(status, { "Content-Type": "application/json", "Mcp-Session-Id": session });
      res.end(JSON.stringify(payload));
    };
    if (body.method === "initialize") {
      send({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "failrec", version: "1" } } });
    } else if (body.method === "tools/list") {
      send({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "doomed", inputSchema: { type: "object" } }] } });
    } else {
      callCount += 1;
      send({ jsonrpc: "2.0", id: body.id, error: { code: -32001, message: "session expired" } });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  writeFileSync(userConfigPath(agentDir), JSON.stringify({ mcp: { servers: { failrec: { type: "remote", url, oauth: false } } } }));
  const manager = createMcpManager({ agentDir, projectRoot });
  try {
    await manager.start();
    await assert.rejects(manager.callTool("failrec", "doomed", {}), /session expired/i);
    assert.ok(callCount >= 2, "recovery retried once before surfacing the failure");
    assert.equal(manager.status("failrec")?.status, "failed");
    assert.deepEqual(manager.serverNames(), [], "failed replacement transport is closed and untracked");
  } finally {
    await manager.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
