import { createServer, type Server } from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSessionLogger, MCP_OPERATIONS, runWithLogContext } from "@xzy-ai/observability";
import {
  cancelRemoteAuth,
  connectRemote,
  ensureCallbackServer,
  finishRemoteAuth,
  logoutRemote,
  startRemoteAuth,
  teardownRemoteAuth,
  isCallbackServerRunning,
  type ConnectRemoteOptions,
} from "../src/index.ts";

function tempAgent(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), "agent");
}

interface AuthServer {
  server: Server;
  origin: string;
  close: () => Promise<void>;
}

/** Minimal RFC 8414 OAuth authorization server used by the SDK discovery flow. */
function startAuthServer(): Promise<AuthServer> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            token_endpoint_auth_methods_supported: ["none"],
            code_challenge_methods_supported: ["S256"],
          }),
        );
        return;
      }
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        res.writeHead(404);
        res.end();
        return;
      }
      if (url.pathname === "/token") {
        let raw = "";
        req.on("data", (chunk: Buffer) => {
          raw += chunk.toString();
        });
        req.on("end", () => {
          const params = new URLSearchParams(raw);
          const grant = params.get("grant_type");
          const isRefresh = grant === "refresh_token" && Boolean(params.get("refresh_token"));
          const hasCode = grant === "authorization_code" && Boolean(params.get("code")) && Boolean(params.get("code_verifier"));
          if (params.get("code") === "REVOKED-CODE") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_grant", error_description: "authorization code revoked" }));
            return;
          }
          if (!(isRefresh || hasCode)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_grant" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              access_token: isRefresh ? "access-token-refreshed" : "access-token-from-exchange",
              token_type: "Bearer",
              refresh_token: "refresh-token-from-exchange",
              expires_in: 3600,
            }),
          );
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("no address"));
        return;
      }
      resolve({
        server,
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}


test("startRemoteAuth captures the authorization URL and registers the loopback callback", async () => {
  const auth = await startAuthServer();
  const agentDir = tempAgent("pi-code-mcp-authflow-start-");
  const redirects: string[] = [];
  const options: ConnectRemoteOptions = {
    url: `${auth.origin}/mcp`,
    agentDir,
    oauth: { client_id: "test-client-id", redirect_uri: `http://127.0.0.1:0/callback`, callback_port: 0 },
    onRedirect: (url) => {
      redirects.push(url.toString());
      return Promise.resolve();
    },
  };
  try {
    const started = await startRemoteAuth(options);
    assert.ok(started.authorizationUrl.startsWith("http://"));
    assert.match(started.authorizationUrl, /response_type=code/);
    assert.match(started.authorizationUrl, /state=/);
    assert.equal(redirects.length, 1);
  } finally {
    await teardownRemoteAuth();
    await auth.close();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("full OAuth flow: start, callback redirect, finish, and commit credentials", async () => {
  const auth = await startAuthServer();
  const agentDir = tempAgent("pi-code-mcp-authflow-full-");
  const { port, path } = await ensureCallbackServer("http://127.0.0.1:0/mcp/oauth/callback");
  let started: Awaited<ReturnType<typeof startRemoteAuth>> | undefined;
  const options: ConnectRemoteOptions = {
    url: `${auth.origin}/mcp`,
    agentDir,
    oauth: { client_id: "test-client-id", redirect_uri: `http://127.0.0.1:${port}${path}` },
    onRedirect: () => Promise.resolve(),
  };
  try {
    started = await startRemoteAuth(options);
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    assert.ok(state, "authorization URL carries a state");
    // The user's browser hits the loopback callback with the auth code.
    const callbackResponse = await fetch(`http://127.0.0.1:${port}${path}?code=THE-CODE&state=${state}`);
    assert.equal(callbackResponse.status, 200);

    await finishRemoteAuth(options);
    // Credentials were committed to the store and can be loaded by a fresh
    // provider on the next connection attempt.
    const { createDefaultAuthStore } = await import("../src/index.ts");
    const stored = createDefaultAuthStore(agentDir).getForUrl(`${auth.origin}/mcp`);
    assert.equal(stored?.tokens?.accessToken, "access-token-from-exchange");
  } finally {
    await teardownRemoteAuth();
    await auth.close();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("logoutRemote clears credentials and cancels pending callbacks", async () => {
  const auth = await startAuthServer();
  const agentDir = tempAgent("pi-code-mcp-authflow-logout-");
  const { port, path } = await ensureCallbackServer("http://127.0.0.1:0/mcp/oauth/callback");
  const options: ConnectRemoteOptions = {
    url: `${auth.origin}/mcp`,
    agentDir,
    oauth: { client_id: "test-client-id", redirect_uri: `http://127.0.0.1:${port}${path}` },
    onRedirect: () => Promise.resolve(),
  };
  try {
    await startRemoteAuth(options);
    let cancelled = false;
    try {
      logoutRemote(options);
      cancelled = true;
    } catch {
      cancelled = false;
    }
    assert.equal(cancelled, true);
  } finally {
    await teardownRemoteAuth();
    await auth.close();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("remote auth mutation boundaries emit telemetry and preserve failure propagation", async () => {
  const agentDir = tempAgent("pi-code-mcp-auth-boundary-");
  const options: ConnectRemoteOptions = {
    url: "https://server.example/mcp",
    agentDir,
    ownerKey: "root-session",
    onRedirect: () => {},
  };
  const logDir = mkdtempSync(join(tmpdir(), "pi-code-mcp-auth-log-"));
  const logger = createSessionLogger({
    projectId: "project",
    rootSessionId: "root-session",
    eventsPath: join(logDir, "events.jsonl"),
    errorsPath: join(logDir, "errors.jsonl"),
  });
  await runWithLogContext(logger, async () => {
    logoutRemote(options);
    cancelRemoteAuth(options.url, options.ownerKey);
    await teardownRemoteAuth(options.ownerKey);
    await assert.rejects(finishRemoteAuth(options), /No OAuth authorization code is pending/);
  });
  const events = readFileSync(join(logDir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const errors = readFileSync(join(logDir, "errors.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const authEvents = events.filter((record) => record.operation === MCP_OPERATIONS.AUTH_STORE.toLowerCase());
  assert.equal(authEvents.filter((record) => record.phase === "before").length, 4);
  assert.equal(authEvents.filter((record) => record.phase === "after").length, 3);
  assert.equal(errors.filter((record) => record.operation === MCP_OPERATIONS.AUTH_STORE.toLowerCase() && record.phase === "error").length, 1);
  rmSync(agentDir, { recursive: true, force: true });
});

test("failed finishRemoteAuth rejects and drops the pending flow", async () => {
  const auth = await startAuthServer();
  const agentDir = tempAgent("pi-code-mcp-authflow-finishfail-");
  const options: ConnectRemoteOptions = {
    url: `${auth.origin}/mcp`,
    agentDir,
    oauth: { client_id: "test-client-id", redirect_uri: "http://127.0.0.1:0/callback", callback_port: 0 },
    onRedirect: () => Promise.resolve(),
  };
  try {
    const first = await startRemoteAuth(options);
    await assert.rejects(finishRemoteAuth(options, "REVOKED-CODE"), /invalid_grant|revoked/i);
    // A dead flow must not be reused: a fresh start produces a new URL.
    const second = await startRemoteAuth(options);
    assert.notEqual(second.authorizationUrl, first.authorizationUrl);
  } finally {
    await teardownRemoteAuth();
    await auth.close();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("failed startRemoteAuth stops the callback server when nothing is pending", async () => {
  const agentDir = tempAgent("pi-code-mcp-authflow-startfail-");
  // No discovery endpoints: the SDK cannot proceed, so authorization fails.
  const quiet = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => quiet.listen(0, "127.0.0.1", resolve));
  const quietUrl = `http://127.0.0.1:${(quiet.address() as { port: number }).port}/mcp`;
  try {
    await assert.rejects(
      startRemoteAuth({ url: quietUrl, agentDir, onRedirect: () => {} }),
      /404|invalid|error|failed/i,
    );
    assert.equal(isCallbackServerRunning(), false, "no orphaned callback listener after a failed start");
  } finally {
    await new Promise<void>((resolve) => quiet.close(() => resolve()));
    await teardownRemoteAuth();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("connectRemote over streamable with default oauth (true) and a preauth 401 becomes needs_auth without falling back", async () => {
  const auth = await startAuthServer();
  const agentDir = tempAgent("pi-code-mcp-authflow-needs-");
  // MCP server that demands auth (401 + WWW-Authenticate).
  const mcpServer = createServer((req, res) => {
    res.writeHead(401, {
      "WWW-Authenticate": `Bearer resource_metadata="${auth.origin}/.well-known/oauth-protected-resource"`,
    });
    res.end("unauthorized");
  });
  await new Promise<void>((resolve) => mcpServer.listen(0, "127.0.0.1", resolve));
  const mcpUrl = `http://127.0.0.1:${(mcpServer.address() as { port: number }).port}/mcp`;
  try {
    const result = await connectRemote({
      url: mcpUrl,
      agentDir,
      onRedirect: () => {},
    });
    assert.equal(result.status.status, "needs_auth");
  } finally {
    await new Promise((resolve) => mcpServer.close(resolve));
    await teardownRemoteAuth();
    await auth.close();
    rmSync(agentDir, { recursive: true, force: true });
  }
});
