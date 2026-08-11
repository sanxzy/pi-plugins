import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  expandEnv,
  loadMcpConfig,
  parseJsonc,
  projectConfigPath,
  resolveLocalCwd,
  resolveLocalEnvironment,
  userAgentDir,
  userConfigPath,
} from "../src/index.ts";
import type { McpServerConfig } from "../src/index.ts";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-mcp-config-"));
}

function writeUser(agentDir: string, content: string): string {
  const file = join(agentDir, "pi-code", "mcp.json");
  mkdirSync(join(agentDir, "pi-code"), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function writeProject(projectRoot: string, content: string): string {
  const file = join(projectRoot, ".pi", "mcp.json");
  mkdirSync(join(projectRoot, ".pi"), { recursive: true });
  writeFileSync(file, content);
  return file;
}

test("loads permissions with project precedence and preserves rule order", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-mcp-config-policy-"));
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  mkdirSync(join(projectRoot, ".pi"), { recursive: true });
  mkdirSync(join(agentDir, "pi-code"), { recursive: true });
  writeFileSync(userConfigPath(agentDir), JSON.stringify({ mcp: { permissions: {
    tools: [{ effect: "allow", server: "demo", name: "read" }],
  } } }));
  writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ mcp: { permissions: {
    tools: [{ effect: "deny", server: "demo", name: "read" }],
  } } }));
  const result = loadMcpConfig(agentDir, projectRoot);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.permissions?.tools, [
    { effect: "deny", server: "demo", name: "read" },
    { effect: "allow", server: "demo", name: "read" },
  ]);
  rmSync(root, { recursive: true, force: true });
});

test("loads JSONC user and project configuration with deep merge and project precedence", () => {
  const agentDir = join(tmpRoot(), "agent");
  const projectRoot = join(tmpRoot(), "project");
  writeUser(
    agentDir,
    `{
      // user-level comments and trailing commas are allowed
      "mcp": {
        "timeout": { "startup": 5000 },
        "servers": {
          "local-a": { "type": "local", "command": ["node", "server.js"], "cwd": "/u" },
          "shared": { "type": "local", "command": ["node", "base.js"], "timeout": { "startup": 1000 } },
          "remote-a": { "type": "remote", "url": "https://user.example", "oauth": false },
        },
      },
    }`,
  );
  writeProject(
    projectRoot,
    `{
      "mcp": {
        "servers": {
          "shared": { "type": "local", "command": ["node", "project.js"], "timeout": { "request": 2000 } },
        },
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
  // Project command wins; user startup timeout is preserved; project request wins.
  assert.deepEqual(shared.command, ["node", "project.js"]);
  assert.equal(shared.timeout?.startup, 1000);
  assert.equal(shared.timeout?.request, 2000);
  assert.equal(result.value.timeout?.startup, 5000);
});

test("missing user and project sources are harmless and still merge what exists", () => {
  const agentDir = join(tmpRoot(), "empty-agent");
  const projectRoot = join(tmpRoot(), "empty-project");
  const empty = loadMcpConfig(agentDir, projectRoot, { env: {} });
  assert.equal(empty.ok, true);
  if (!empty.ok) return;
  assert.deepEqual(empty.value.servers, {});
  assert.equal(empty.issues.length, 0);

  // Project-only config still loads.
  mkdirSync(join(projectRoot, ".pi"), { recursive: true });
  writeFileSync(join(projectRoot, ".pi", "mcp.json"), `{"mcp":{"servers":{"p":{"type":"local","command":["n","s"]}}}}`);
  const projectOnly = loadMcpConfig(agentDir, projectRoot, { env: {} });
  assert.equal(projectOnly.ok, true);
  if (!projectOnly.ok) return;
  assert.deepEqual(Object.keys(projectOnly.value.servers), ["p"]);
  assert.equal(projectOnly.issues.length, 0);
});

test("invalid individual server entries are skipped without preventing valid entries", () => {
  const agentDir = join(tmpRoot(), "agent");
  writeUser(
    agentDir,
    `{
      "mcp": {
        "servers": {
          "bad": { "type": "local" },
          "good": { "type": "local", "command": ["node", "ok.js"] },
        }
      }
    }`,
  );
  const projectRoot = join(tmpRoot(), "project");
  const result = loadMcpConfig(agentDir, projectRoot, { env: {} });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(Object.keys(result.value.servers), ["good"]);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0].message, /bad/);
});

test("JSONC parse errors on a source are reported; other source still loads", () => {
  const agentDir = join(tmpRoot(), "agent");
  writeUser(agentDir, "{ broken");
  const projectRoot = join(tmpRoot(), "project");
  writeProject(projectRoot, `{"mcp":{"servers":{"ok":{"type":"remote","url":"https://x.example"}}}}`);
  const result = loadMcpConfig(agentDir, projectRoot, { env: {} });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(Object.keys(result.value.servers), ["ok"]);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0].source, /user/);
});

test("environment references expand in values without leaking secrets", () => {
  const agentDir = join(tmpRoot(), "agent");
  writeUser(
    agentDir,
    `{"mcp":{"servers":{
      "r":{"type":"remote","url":"https://x.example","headers":{"Authorization":"Bearer \${SECRET}"}},
      "bad":{"type":"remote"}
    }}}`,
  );
  const projectRoot = join(tmpRoot(), "project");
  const result = loadMcpConfig(agentDir, projectRoot, { env: { SECRET: "abc123" } });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const remote = result.value.servers.r;
  assert.equal(remote.type, "remote");
  assert.deepEqual(remote.headers, { Authorization: "Bearer abc123" });
  // The invalid entry is reported while the valid entry still loads.
  assert.equal(result.issues.length, 1);
  // Verification: expandEnv unknown -> empty.
  assert.equal(expandEnv("x ${NOPE} y", { M: "1" }), "x  y");
  // The diagnostics never echo back the resolved secret value even when issues exist.
  assert.equal(result.issues.some((issue) => issue.message.includes("abc123")), false);
});

test("path helpers resolve through the Pi user-agent directory contract", () => {
  const agentDir = join(tmpRoot(), "agent");
  assert.equal(userAgentDir(agentDir), agentDir);
  assert.ok(userConfigPath(agentDir).endsWith(join(agentDir, "pi-code", "mcp.json")));
});

test("project config path lives under the project .pi directory", () => {
  const projectRoot = join(tmpRoot(), "proj");
  assert.equal(projectConfigPath(projectRoot), join(projectRoot, ".pi", "mcp.json"));
});

test("JSONC helpers parse comments and trailing commas", () => {
  const parsed = parseJsonc(`{\n// comment\n"a": [1, 2,],\n}`);
  assert.equal("error" in parsed, false);
  if ("error" in parsed) return;
  assert.deepEqual(parsed.value, { a: [1, 2] });
});

test("local environment resolves inherited process environment plus configured overrides and resolves relative cwd", () => {
  const server: McpServerConfig = {
    type: "local",
    command: ["node", "s.js"],
    environment: { PATH: "/override", EXTRA: "x" },
  };
  const env = resolveLocalEnvironment(server, { PATH: "/base", HOME: "/home" });
  assert.equal(env.PATH, "/override");
  assert.equal(env.EXTRA, "x");
  assert.equal(env.HOME, "/home");

  const cwd = resolveLocalCwd(server, "/projects/app");
  assert.equal(cwd, "/projects/app");
});
