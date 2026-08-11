import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { authStorePath, createAuthStore } from "../src/auth-store.ts";

function tempAgentDir(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), "agent");
}

test("auth store persists entries atomically with owner-only mode", async () => {
  const agentDir = tempAgentDir("pi-code-mcp-auth-agent-");
  const store = createAuthStore(authStorePath(agentDir));
  store.update("https://server.example/mcp", (prior) => ({
    ...prior,
    tokens: { accessToken: "secret-token", refreshToken: "refresh-token", scope: "read" },
  }));
  const reloaded = createAuthStore(authStorePath(agentDir));
  assert.equal(reloaded.get("https://server.example/mcp")?.tokens?.accessToken, "secret-token");
  assert.equal(existsSync(authStorePath(agentDir)), true);
  const mode = (await import("node:fs")).statSync(authStorePath(agentDir)).mode & 0o777;
  assert.equal(mode, 0o600);
  rmSync(agentDir, { recursive: true, force: true });
});

test("credentials are scoped to the exact server URL", async () => {
  const agentDir = tempAgentDir("pi-code-mcp-auth-url-");
  const store = createAuthStore(authStorePath(agentDir));
  store.set("https://one.example/mcp", { serverUrl: "https://one.example/mcp", tokens: { accessToken: "a" } });
  store.set("https://two.example/mcp", { serverUrl: "https://two.example/mcp", tokens: { accessToken: "b" } });
  assert.equal(store.getForUrl("https://one.example/mcp")?.tokens?.accessToken, "a");
  assert.equal(store.getForUrl("https://two.example/mcp")?.tokens?.accessToken, "b");
  assert.equal(store.getForUrl("https://one.example/other"), undefined);
  rmSync(agentDir, { recursive: true, force: true });
});

test("store tolerates and discards corrupt entries", async () => {
  const agentDir = tempAgentDir("pi-code-mcp-auth-corrupt-");
  const path = authStorePath(agentDir);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(agentDir), { recursive: true });
  await import("node:fs").then((fs) => fs.writeFileSync(path, "not json"));
  const store = createAuthStore(path);
  assert.equal(store.get("https://corrupt.example/mcp"), undefined);
  store.update("https://ok.example/mcp", () => ({ tokens: { accessToken: "ok" } }));
  assert.equal(store.get("https://ok.example/mcp")?.tokens?.accessToken, "ok");
  rmSync(agentDir, { recursive: true, force: true });
});

test("remove deletes only the targeted URL entry", async () => {
  const agentDir = tempAgentDir("pi-code-mcp-auth-remove-");
  const store = createAuthStore(authStorePath(agentDir));
  store.set("https://a.example/mcp", { serverUrl: "https://a.example/mcp", tokens: { accessToken: "a" } });
  store.set("https://b.example/mcp", { serverUrl: "https://b.example/mcp", tokens: { accessToken: "b" } });
  store.remove("https://a.example/mcp");
  assert.equal(store.get("https://a.example/mcp"), undefined);
  assert.equal(store.get("https://b.example/mcp")?.tokens?.accessToken, "b");
  rmSync(agentDir, { recursive: true, force: true });
});

test("atomic rename leaves no temp files behind", async () => {
  const agentDir = tempAgentDir("pi-code-mcp-auth-tmp-");
  const path = authStorePath(agentDir);
  const store = createAuthStore(path);
  for (let i = 0; i < 5; i += 1) store.update(`https://server-${i}.example/mcp`, () => ({ tokens: { accessToken: `t${i}` } }));
  const leftovers = readFileSync(path, "utf8").includes(".tmp") === false;
  assert.equal(leftovers, true);
  rmSync(agentDir, { recursive: true, force: true });
});