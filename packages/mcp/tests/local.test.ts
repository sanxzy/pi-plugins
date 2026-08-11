import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createMcpManager } from "../src/index.ts";

const fixture = fileURLToPath(new URL("./fixtures/stdio-server.ts", import.meta.url));
const fixtureCwd = dirname(fixture);

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("connects a local stdio server, initializes MCP, and discovers tools", async () => {
  const agentDir = join(tempRoot("pi-code-mcp-local-agent-"), "agent");
  const projectRoot = tempRoot("pi-code-mcp-local-project-");
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
  const agentDir = join(tempRoot("pi-code-mcp-local-agent2-"), "agent");
  const projectRoot = tempRoot("pi-code-mcp-local-project2-");
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
  assert.deepEqual(manager.status("disabled"), { status: "disabled" });
  assert.equal(manager.status("failed")?.status, "failed");

  await manager.close();
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});
