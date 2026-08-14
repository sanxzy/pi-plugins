import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createSessionLogger, MCP_OPERATIONS, runWithLogContext } from "@xzy-ai/observability";
import { createMcpManager, terminateProcessTree, ProcessStdioTransport, userConfigPath } from "../src/index.ts";

const fixture = new URL("./fixtures/stdio-server.ts", import.meta.url).pathname;
const fixtureCwd = dirname(fixture);

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("start() auto-connects configured local servers from the effective configuration", async () => {
  const agentDir = join(tempRoot("pi-c2-mcp-local-agent3-"), "agent");
  const projectRoot = tempRoot("pi-c2-mcp-local-project3-");
  mkdirSync(join(agentDir, "pi-c2"), { recursive: true });
  writeFileSync(
    userConfigPath(agentDir),
    JSON.stringify({
      mcp: {
        servers: {
          fixture: { type: "local", command: [process.execPath, fixture], cwd: fixtureCwd },
        },
      },
    }),
  );
  const manager = createMcpManager({ agentDir, projectRoot });
  const state = await manager.start();
  assert.equal(state.servers.fixture?.status, "connected");
  assert.equal(state.servers.fixture?.toolCount, 1);
  await manager.stop();
  assert.equal(manager.status("fixture")?.status, "disabled");
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

test("connects a local stdio server, initializes MCP, and discovers tools", async () => {
  const agentDir = join(tempRoot("pi-c2-mcp-local-agent-"), "agent");
  const projectRoot = tempRoot("pi-c2-mcp-local-project-");
  const manager = createMcpManager({ agentDir, projectRoot });
  const result = await manager.connectLocal("fixture", {
    type: "local",
    command: [process.execPath, fixture],
    cwd: fixtureCwd,
    environment: {},
    timeout: { startup: 5_000, request: 5_000 },
  });

  assert.equal(result.status.status, "connected");
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0]?.name, "current_directory");
  assert.equal(result.tools[0]?.description, fixtureCwd);

  await manager.close();
  assert.equal(manager.status("fixture")?.status, "disabled");
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

test("a disabled local server does not spawn and a failed server is isolated", async () => {
  const agentDir = join(tempRoot("pi-c2-mcp-local-agent2-"), "agent");
  const projectRoot = tempRoot("pi-c2-mcp-local-project2-");
  const manager = createMcpManager({ agentDir, projectRoot });
  const disabled = await manager.connectLocal("disabled", {
    type: "local",
    command: [process.execPath, fixture],
    disabled: true,
  });
  assert.equal(disabled.status.status, "disabled");
  assert.deepEqual(disabled.tools, []);

  const failed = await manager.connectLocal("failed", {
    type: "local",
    command: [process.execPath, join(projectRoot, "missing-server.ts")],
    timeout: { startup: 500 },
  });
  assert.equal(failed.status.status, "failed");
  assert.deepEqual(manager.status("disabled"), { status: "disabled", errorCategory: "none" });
  assert.equal(manager.status("failed")?.status, "failed");
  assert.equal(manager.status("failed")?.errorCategory, "transport");

  await manager.close();
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

test("full-catalog discovery follows cursors and preserves valid results when another server fails", async () => {
  const agentDir = join(tempRoot("pi-c2-mcp-local-agentf-"), "agent");
  const projectRoot = tempRoot("pi-c2-mcp-local-projectf-");
  mkdirSync(join(agentDir, "pi-c2"), { recursive: true });
  writeFileSync(
    userConfigPath(agentDir),
    JSON.stringify({
      mcp: {
        timeout: { startup: 5_000, request: 5_000 },
        servers: {
          full: { type: "local", command: [process.execPath, fixture], cwd: fixtureCwd, environment: { MCP_FIXTURE_MODE: "full-catalog" } },
          fail: { type: "local", command: [process.execPath, fixture], cwd: fixtureCwd, environment: { MCP_FIXTURE_MODE: "fail-discovery" } },
        },
      },
    }),
  );
  const manager = createMcpManager({ agentDir, projectRoot });
  const state = await manager.start();

  assert.equal(state.servers.full?.status, "connected");
  assert.equal(state.servers.fail?.status, "failed");

  // The valid server's catalog is preserved end-to-end.
  const fullResult = await manager.connectLocal("full", {
    type: "local",
    command: [process.execPath, fixture],
    cwd: fixtureCwd,
    environment: { MCP_FIXTURE_MODE: "full-catalog" },
  });
  assert.equal(fullResult.status.status, "connected");
  assert.deepEqual(
    fullResult.catalog.prompts.map((prompt) => prompt.name),
    ["first_prompt", "second_prompt"],
  );
  assert.deepEqual(
    fullResult.catalog.resources.map((resource) => resource.name),
    ["first_resource", "second_resource"],
  );
  assert.deepEqual(
    fullResult.catalog.resourceTemplates.map((template) => template.name),
    ["first_template", "second_template"],
  );

  await manager.close();
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

test("startup timeout kills a hanging server and cancellation is aborted into failed status", async () => {
  const agentDir = join(tempRoot("pi-c2-mcp-local-agenth-"), "agent");
  const projectRoot = tempRoot("pi-c2-mcp-local-projecth-");
  const manager = createMcpManager({ agentDir, projectRoot });

  const hung = await manager.connectLocal("hung", {
    type: "local",
    command: [process.execPath, fixture],
    cwd: fixtureCwd,
    environment: { MCP_FIXTURE_MODE: "hang" },
    timeout: { startup: 300 },
  });
  assert.equal(hung.status.status, "failed");
  assert.match(hung.status.error, /timed out/);

  // Cancellation of an in-flight connect surfaces as failed without crashing.
  const controller = new AbortController();
  const cancelled = manager.connectLocal("cancelled", {
    type: "local",
    command: [process.execPath, fixture],
    cwd: fixtureCwd,
    environment: { MCP_FIXTURE_MODE: "hang" },
  }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();
  const cancelledResult = await cancelled;
  assert.equal(cancelledResult.status.status, "failed");

  await manager.close();
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

test("global timeout config applies as fallback for startup", async () => {
  const agentDir = join(tempRoot("pi-c2-mcp-local-agentg-"), "agent");
  const projectRoot = tempRoot("pi-c2-mcp-local-projectg-");
  mkdirSync(join(agentDir, "pi-c2"), { recursive: true });
  writeFileSync(
    userConfigPath(agentDir),
    JSON.stringify({
      mcp: {
        timeout: { startup: 300 },
        servers: {
          hung: { type: "local", command: [process.execPath, fixture], cwd: fixtureCwd, environment: { MCP_FIXTURE_MODE: "hang" } },
        },
      },
    }),
  );
  const manager = createMcpManager({ agentDir, projectRoot });
  const state = await manager.start();
  assert.equal(state.servers.hung?.status, "failed");
  assert.match(state.servers.hung?.error ?? "", /timed out after 300ms/);
  await manager.close();
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

test("session shutdown terminates local descendants in the process group", async () => {
  const agentDir = join(tempRoot("pi-c2-mcp-local-agentd-"), "agent");
  const projectRoot = tempRoot("pi-c2-mcp-local-projectd-");
  const childPidFile = join(tempRoot("pi-c2-mcp-local-child-"), "child.pid");
  mkdirSync(dirname(childPidFile), { recursive: true });
  const manager = createMcpManager({ agentDir, projectRoot });
  const result = await manager.connectLocal("fixture", {
    type: "local",
    command: [process.execPath, fixture],
    cwd: fixtureCwd,
    environment: { MCP_FIXTURE_CHILD_PID_FILE: childPidFile },
  });
  assert.equal(result.status.status, "connected");

  const childPid = Number(readFileSync(childPidFile, "utf8").trim());
  assert.ok(childPid > 0);
  assert.ok(isProcessAlive(childPid), "fixture descendant should be alive before shutdown");

  await manager.close();
  // The manager's group termination must reach the grandchild even though the
  // direct child ignores SIGTERM and stays resident.
  await waitForDeath(childPid, 5_000);
  assert.equal(isProcessAlive(childPid), false, "descendant must be terminated at shutdown");

  rmSync(agentDir, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(dirname(childPidFile), { recursive: true, force: true });
});

test("local server stderr is piped and bounded on the transport", async () => {
  const transport = new ProcessStdioTransport({
    command: process.execPath,
    args: [fixture],
    cwd: fixtureCwd,
    env: { MCP_FIXTURE_STDERR: "1" },
    stderr: "pipe",
  });
  try {
    await transport.start();
    // stderr data arrives asynchronously after spawn; wait for the marker.
    const deadline = Date.now() + 3_000;
    while (!transport.stderrText.includes("stderr-") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(transport.stderrText.includes("stderr-"), "server stderr should be captured on the transport");
    assert.ok(transport.stderrText.length <= 32 * 1024, "stderr capture must be bounded");
  } finally {
    await transport.close();
  }
});

test("stdio process lifecycle emits start/send/close/terminate telemetry", async () => {
  const root = tempRoot("pi-c2-mcp-stdio-log-");
  const logDir = join(root, "logs");
  const logger = createSessionLogger({
    projectId: "project",
    rootSessionId: "root-session",
    eventsPath: join(logDir, "events.jsonl"),
    errorsPath: join(logDir, "errors.jsonl"),
  });
  const transport = new ProcessStdioTransport({
    command: process.execPath,
    args: [fixture],
    cwd: fixtureCwd,
  });
  try {
    await runWithLogContext(logger, async () => {
      await transport.start();
      await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      await transport.close();
    });
    const records = readFileSync(join(logDir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const operation of [MCP_OPERATIONS.STDIO_START, MCP_OPERATIONS.STDIO_SEND, MCP_OPERATIONS.STDIO_CLOSE, MCP_OPERATIONS.PROCESS_TERMINATE]) {
      assert.ok(records.some((record) => record.operation === operation && record.phase === "before"), `missing ${operation}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("closing a transport before spawn completes rejects startup and kills the process", async () => {
  const transport = new ProcessStdioTransport({
    command: process.execPath,
    args: [fixture],
    cwd: fixtureCwd,
  });
  await transport.close();
  await assert.rejects(transport.start(), /closed during startup/);
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDeath(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
