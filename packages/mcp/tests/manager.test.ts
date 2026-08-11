import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createMcpManager, projectConfigPath, userConfigPath } from "../src/index.ts";

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
