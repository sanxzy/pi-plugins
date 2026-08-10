import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadMcpConfig } from "../src/index.ts";
import type { McpServerConfig } from "../src/index.ts";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-mcp-config-"));
}

function writeUser(agentDir: string, content: string): string {
  const file = join(agentDir, "mcp.json");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(file, content);
  return file;
}

function writeProject(projectRoot: string, content: string): string {
  const file = join(projectRoot, ".pi", "mcp.json");
  mkdirSync(join(projectRoot, ".pi"), { recursive: true });
  writeFileSync(file, content);
  return file;
}

test("loads JSONC user and project configuration with deep merge and project precedence", () => {
  const agentDir = join(tmpRoot(), "agent");
  const projectRoot = join(tmpRoot(), "project");
  writeUser(
    agentDir,
    `{
      // user-level comments are allowed
      "mcp": {
        "servers": {
          "local-a": { "type": "local", "command": ["node", "server.js"], "cwd": "/u" },
          "shared": { "type": "local", "command": ["node", "base.js"], "timeout": { "startup": 1000 } },
          "remote-a": { "type": "remote", "url": "https://user.example", "oauth": false }
        }
      },
    }`,
  );
  writeProject(
    projectRoot,
    `{
      "mcp": {
        "servers": {
          "shared": { "type": "local", "command": ["node", "project.js"], "timeout": { "request": 2000 } },
        }
      },
    }`,
  );

  const result = loadMcpConfig(agentDir, projectRoot, { env: {}, cwd: projectRoot });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const servers = result.value.servers;
  assert.deepEqual(Object.keys(servers).sort(), ["local-a", "remote-a", "shared"]);
  const shared: McpServerConfig = servers.shared;
  assert.equal(shared.type, "local");
  // Project command wins over user command; user startup timeout is preserved.
  assert.deepEqual(shared.command, ["node", "project.js"]);
  assert.equal(shared.timeout?.startup, 1000);
  assert.equal(shared.timeout?.request, 2000);
});
