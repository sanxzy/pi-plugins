import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connectRemote, createMcpManager, userConfigPath } from "../src/index.ts";
import type { IncomingHttpHeaders } from "node:http";

function tempAgent(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), "agent");
}

interface McpHttpServer {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

interface HeaderCapture {
  headers?: IncomingHttpHeaders;
}

type RpcRequest = { jsonrpc: "2.0"; id: number | string; method: string; params?: Record<string, unknown> };

type FixtureMode = "streamable" | "sse";

function jsonRpcResult(request: RpcRequest, result: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id: request.id, result });
}

function parseBody(req: IncomingMessage): Promise<RpcRequest> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.once("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as RpcRequest);
      } catch (error) {
        reject(error);
      }
    });
    req.once("error", reject);
  });
}

function startFixture(mode: FixtureMode, tools: string[], capture?: HeaderCapture): Promise<McpHttpServer> {
  return new Promise((resolve, reject) => {
    const sessions = new Set<string>();
    let nextSession = 1;
    const sseClients = new Map<string, ServerResponse>();
    const server = createServer(async (req, res) => {
      try {
        if (mode === "sse") {
          if (req.method !== "POST") {
            // Only the legacy SSE GET stream is served; other GETs are the
            // Streamable HTTP probe and must fail so the client falls back.
            if (req.method === "GET") {
              const session = `sse-${nextSession++}`;
              sseClients.set(session, res);
              res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
              });
              res.write(`event: endpoint\ndata: /message?session=${encodeURIComponent(session)}\n\n`);
              req.once("close", () => sseClients.delete(session));
              return;
            }
            res.writeHead(405);
            res.end();
            return;
          }
          const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
          const session = String(requestUrl.searchParams.get("session") ?? "");
          if (!session) {
            // Streamable HTTP probe: reject fast so the SSE fallback runs.
            res.writeHead(404);
            res.end();
            return;
          }
          const stream = sseClients.get(session);
          if (!stream) {
            res.writeHead(404);
            res.end();
            return;
          }
          const body = await parseBody(req);
          if (body.method === "notifications/initialized") {
            res.writeHead(202);
            res.end();
            return;
          }
          const responseMessage = jsonRpcResult(body, listResult(body, tools));
          stream.write(`event: message\ndata: ${responseMessage}\n\n`);
          res.writeHead(202);
          res.end();
          return;
        }

        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        const body = await parseBody(req);
        const sessionHeader = String(req.headers["mcp-session-id"] ?? "");
        let session = sessionHeader;
        if (body.method === "initialize") {
          if (capture) capture.headers = req.headers;
          session = `http-${nextSession++}`;
          sessions.add(session);
        }
        if (body.method !== "initialize" && !sessions.has(session)) {
          res.writeHead(400);
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "missing session" } }));
          return;
        }
        const payload = body.method === "initialize"
          ? jsonRpcResult(body, {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "pi-http-fixture", version: "1.0.0" },
            })
          : jsonRpcResult(body, listResult(body, tools));
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Mcp-Session-Id": session,
        });
        res.end(payload);
      } catch (error) {
        res.writeHead(500);
        res.end(String(error));
      }
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
        url: `http://127.0.0.1:${address.port}/mcp`,
        close: () => new Promise<void>((done) => {
          for (const response of sseClients.values()) response.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}

function listResult(request: RpcRequest, tools: string[]): Record<string, unknown> {
  if (request.method === "initialize") {
    return {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "pi-http-fixture", version: "1.0.0" },
    };
  }
  if (request.method === "tools/list") {
    return { tools: tools.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })) };
  }
  return {};
}

test("connectRemote connects over Streamable HTTP and discovers tools", async () => {
  const fixture = await startFixture("streamable", ["remote_tool"]);
  const agentDir = tempAgent("pi-code-mcp-remote-agent-");
  const result = await connectRemote({ url: fixture.url, agentDir, oauth: false, onRedirect: () => {} });
  try {
    assert.equal(result.status.status, "connected");
    assert.deepEqual(result.catalog.tools.map((tool) => tool.name), ["remote_tool"]);
  } finally {
    await result.client?.close();
    await fixture.close();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("connectRemote delivers configured headers to the transport", async () => {
  const capture: HeaderCapture = {};
  const fixture = await startFixture("streamable", ["header_tool"], capture);
  const agentDir = tempAgent("pi-code-mcp-remote-headers-");
  const result = await connectRemote({
    url: fixture.url,
    agentDir,
    oauth: false,
    headers: { Authorization: "Bearer resolved-secret", "X-Test-Header": "present" },
    onRedirect: () => {},
  });
  try {
    assert.equal(result.status.status, "connected");
    assert.equal(capture.headers?.authorization, "Bearer resolved-secret");
    assert.equal(capture.headers?.["x-test-header"], "present");
  } finally {
    await result.client?.close();
    await fixture.close();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("connectRemote enforces a bounded startup timeout", async () => {
  const server = createServer((_req, _res) => {
    // Leave the request pending; the transport startup deadline must settle.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const agentDir = tempAgent("pi-code-mcp-remote-start-timeout-");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  try {
    const started = Date.now();
    const result = await connectRemote({ url, agentDir, oauth: false, timeout: { startup: 100, request: 100 }, onRedirect: () => {} });
    assert.equal(result.status.status, "failed");
    assert.match(result.status.error, /timed out|timeout|failed/i);
    assert.ok(Date.now() - started < 2_000, "startup timeout settles promptly");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("connectRemote enforces the request timeout during catalog discovery", async () => {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    const body = await parseBody(req);
    if (body.method === "initialize") {
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "request-timeout" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {
        protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "timeout-fixture", version: "1" },
      } }));
      return;
    }
    // Deliberately leave tools/list pending so the SDK request timeout fires.
    if (body.method === "tools/list") return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const agentDir = tempAgent("pi-code-mcp-remote-request-timeout-");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  try {
    const started = Date.now();
    const result = await connectRemote({ url, agentDir, oauth: false, timeout: { startup: 500, request: 100 }, onRedirect: () => {} });
    assert.equal(result.status.status, "failed");
    assert.match(result.status.error, /timed out|timeout|request/i);
    assert.ok(Date.now() - started < 2_000, "request timeout settles promptly");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("connectRemote falls back to SSE when Streamable HTTP is unavailable", async () => {
  const fixture = await startFixture("sse", ["sse_tool"]);
  const agentDir = tempAgent("pi-code-mcp-sse-agent-");
  const result = await connectRemote({ url: fixture.url, agentDir, oauth: false, onRedirect: () => {} });
  try {
    assert.equal(result.status.status, "connected");
    assert.equal(result.transport, "sse");
    assert.deepEqual(result.catalog.tools.map((tool) => tool.name), ["sse_tool"]);
  } finally {
    await result.client?.close();
    await fixture.close();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("manager disconnect closes an active remote transport before logout", async () => {
  const fixture = await startFixture("streamable", ["disconnect_tool"]);
  const agentDir = tempAgent("pi-code-mcp-manager-disconnect-agent-");
  const projectRoot = tempAgent("pi-code-mcp-manager-disconnect-project-");
  mkdirSync(join(agentDir, "pi-code"), { recursive: true });
  writeFileSync(userConfigPath(agentDir), JSON.stringify({ mcp: { servers: {
    fixture: { type: "remote", url: fixture.url, oauth: false },
  } } }));
  const manager = createMcpManager({ agentDir, projectRoot });
  try {
    await manager.start();
    assert.equal(manager.status("fixture")?.status, "connected");
    await manager.disconnect("fixture");
    assert.notEqual(manager.status("fixture")?.status, "connected");
  } finally {
    await manager.close();
    await fixture.close();
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("connectRemote reports a bounded failure for unreachable hosts", async () => {
  const agentDir = tempAgent("pi-code-mcp-remote-failed-");
  try {
    const result = await connectRemote({
      url: "http://127.0.0.1:1/mcp",
      agentDir,
      oauth: false,
      timeout: { startup: 500, request: 500 },
      onRedirect: () => {},
    });
    assert.equal(result.status.status, "failed");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("connectRemote aborts a hanging SSE startup when the signal fires or startup times out", async () => {
  const agentDir = tempAgent("pi-code-mcp-remote-abort-");
  // An SSE server that opens the GET stream but never completes initialization.
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": keep-alive\n\n");
      setInterval(() => res.write(": ping\n\n"), 5000).unref();
      return;
    }
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/sse`;
  try {
    const controller = new AbortController();
    const connecting = connectRemote({
      url,
      agentDir,
      oauth: false,
      timeout: { startup: 20_000 },
      signal: controller.signal,
      onRedirect: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    const result = await Promise.race([
      connecting.catch((error) => ({ aborted: true, error: String(error) })),
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 4000)),
    ]);
    const resolved = result as { aborted?: boolean; timedOut?: boolean; error?: string; status?: { status: string; error?: string } };
    assert.equal(resolved.timedOut, undefined, "abort must settle the connect rather than hang");
    assert.equal(resolved.aborted, undefined, "connectRemote resolves a bounded status instead of hanging");
    assert.equal(resolved.status?.status, "failed");
    assert.match(resolved.status?.error ?? "", /aborted/i, "the failure names the abort");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("manager start() connects configured remote servers with the effective config", async () => {
  const fixture = await startFixture("streamable", ["manager_tool"]);
  const agentDir = tempAgent("pi-code-mcp-mgr-remote-agent-");
  const projectRoot = tempAgent("pi-code-mcp-mgr-remote-project-");
  mkdirSync(join(agentDir, "pi-code"), { recursive: true });
  writeFileSync(
    userConfigPath(agentDir),
    JSON.stringify({
      mcp: {
        servers: {
          fixture: { type: "remote", url: fixture.url, oauth: false },
        },
      },
    }),
  );
  const manager = createMcpManager({ agentDir, projectRoot });
  try {
    const state = await manager.start();
    assert.equal(state.servers.fixture?.status, "connected");
    assert.equal(state.servers.fixture?.toolCount, 1);
  } finally {
    await manager.close();
    await fixture.close();
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("connectRemote reports needs_client_registration when OAuth registration is unavailable", async () => {
  const agentDir = tempAgent("pi-code-mcp-remote-registration-");
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/.well-known/oauth-authorization-server")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        issuer: "http://127.0.0.1",
        authorization_endpoint: "http://127.0.0.1/authorize",
        token_endpoint: "http://127.0.0.1/token",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        token_endpoint_auth_methods_supported: ["none"],
      }));
      return;
    }
    if (req.url?.startsWith("/.well-known/")) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(401, { "WWW-Authenticate": "Bearer" });
    res.end("registration required");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  try {
    const result = await connectRemote({ url, agentDir, timeout: { startup: 1000 }, onRedirect: () => {} });
    assert.equal(result.status.status, "needs_client_registration");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("connectRemote reports needs_auth when a server demands OAuth and stops fallback", async () => {
  const agentDir = tempAgent("pi-code-mcp-remote-auth-");
  const server = createServer((req, res) => {
    res.writeHead(401, {
      "WWW-Authenticate": 'Bearer resource_metadata="https://auth.example.invalid/.well-known/oauth-protected-resource"',
    });
    res.end("unauthorized");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${(address as { port: number }).port}/mcp`;
  try {
    const result = await connectRemote({
      url,
      agentDir,
      timeout: { startup: 1500, request: 1500 },
      onRedirect: () => {},
    });
    assert.equal(result.status.status, "needs_auth");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(agentDir, { recursive: true, force: true });
  }
});
