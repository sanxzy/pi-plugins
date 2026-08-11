import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDefaultAuthStore, PiOAuthProvider, ensureCallbackServer, waitForOAuthCallback, stopCallbackServer, isCallbackServerRunning, parseRedirectUri } from "../src/index.ts";

function tempAgent(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), "agent");
}

function providerFor(agentDir: string, url: string, redirectUri?: string): PiOAuthProvider {
  return new PiOAuthProvider({
    serverUrl: url,
    agentDir,
    redirectUri,
    onRedirect: () => {},
  });
}

test("stored credentials are URL-scoped and reusable across provider instances", async () => {
  const agentDir = tempAgent("pi-code-mcp-oauth-scope-");
  const store = createDefaultAuthStore(agentDir);
  store.update("https://one.example/mcp", () => ({
    tokens: { accessToken: "token-a" },
  }));
  const providerA = providerFor(agentDir, "https://one.example/mcp");
  assert.equal((await providerA.tokens())?.access_token, "token-a");
  const providerB = providerFor(agentDir, "https://two.example/mcp");
  assert.equal(await providerB.tokens(), undefined);
  rmSync(agentDir, { recursive: true, force: true });
});

test("pending tokens commit only after success and never replace working credentials on failure", async () => {
  const agentDir = tempAgent("pi-code-mcp-oauth-commit-");
  const provider = providerFor(agentDir, "https://one.example/mcp");
  await provider.saveTokens({ access_token: "new-token", token_type: "Bearer" });
  // Before commit the store is untouched.
  assert.equal((await providerFor(agentDir, "https://one.example/mcp").tokens()), undefined);
  await provider.commit();
  assert.equal((await providerFor(agentDir, "https://one.example/mcp").tokens())?.access_token, "new-token");

  // A failed reauth (no commit) cannot clobber the working token.
  const again = providerFor(agentDir, "https://one.example/mcp");
  await again.saveTokens({ access_token: "stale-token", token_type: "Bearer" });
  // No commit.
  assert.equal((await providerFor(agentDir, "https://one.example/mcp").tokens())?.access_token, "new-token");

  again.clear();
  assert.equal((await providerFor(agentDir, "https://one.example/mcp").tokens()), undefined);
  rmSync(agentDir, { recursive: true, force: true });
});

test("auth store is only written for the exact server URL", async () => {
  const agentDir = tempAgent("pi-code-mcp-oauth-url-");
  const provider = providerFor(agentDir, "https://one.example/mcp");
  await provider.saveCodeVerifier("verifier-1");
  const store = createDefaultAuthStore(agentDir);
  assert.equal(store.getForUrl("https://one.example/mcp")?.codeVerifier, "verifier-1");
  assert.equal(store.getForUrl("https://one.example/other"), undefined);
  assert.equal(store.get("https://one.example/mcp")?.codeVerifier, "verifier-1");
  const entry = store.get("https://one.example/mcp");
  assert.equal(entry?.serverUrl, "https://one.example/mcp");
  rmSync(agentDir, { recursive: true, force: true });
});

test("parseRedirectUri extracts loopback port and path with safe defaults", async () => {
  assert.deepEqual(parseRedirectUri(), { port: 19876, path: "/mcp/oauth/callback" });
  assert.deepEqual(parseRedirectUri("http://127.0.0.1:4321/cb"), { port: 4321, path: "/cb" });
  assert.deepEqual(parseRedirectUri("not a url"), { port: 19876, path: "/mcp/oauth/callback" });
});

test("callback server binds loopback, validates state, and resolves matching flows", async () => {
  const { port, path } = await ensureCallbackServer("http://127.0.0.1:0/mcp/oauth/callback");
  assert.ok(port > 0, "uses an ephemeral loopback port");
  const pending = waitForOAuthCallback("state-good", "https://server.example/mcp");

  // A mismatched state is rejected without resolving the pending flow.
  const rejected = await fetch(`http://127.0.0.1:${port}${path}?code=CODE&state=state-evil`);
  assert.equal(rejected.status, 400);
  assert.equal(isCallbackServerRunning(), true);

  // The correct state resolves with the authorization code.
  const accepted = await fetch(`http://127.0.0.1:${port}${path}?code=CODE-123&state=state-good`);
  assert.equal(accepted.status, 200);
  assert.equal(await pending, "CODE-123");

  await stopCallbackServer();
  assert.equal(isCallbackServerRunning(), false);
});

test("stopping the callback server rejects still-pending flows", async () => {
  const { port } = await ensureCallbackServer("http://127.0.0.1:0/mcp/oauth/callback");
  const pending = waitForOAuthCallback("state-pending", "https://server.example/mcp");
  await stopCallbackServer();
  await assert.rejects(pending, /stopped/);
  assert.equal(isCallbackServerRunning(), false);
  assert.equal(port > 0, true);
});

test("provider client metadata carries Pi identity and configured OAuth settings", async () => {
  const agentDir = tempAgent("pi-code-mcp-oauth-meta-");
  const provider = providerFor(agentDir, "https://one.example/mcp");
  const metadata = provider.clientMetadata;
  assert.deepEqual(metadata.redirect_uris, ["http://127.0.0.1:19876/mcp/oauth/callback"]);
  assert.equal(metadata.client_name, "pi-code");
  const secured = new PiOAuthProvider({
    serverUrl: "https://one.example/mcp",
    agentDir,
    clientId: "registered-id",
    clientSecret: "registered-secret",
    scope: "read write",
    onRedirect: () => {},
  });
  assert.equal(secured.clientMetadata.token_endpoint_auth_method, "client_secret_post");
  const clientInfo = await secured.clientInformation();
  assert.deepEqual(clientInfo, { client_id: "registered-id", client_secret: "registered-secret" });
  rmSync(agentDir, { recursive: true, force: true });
});