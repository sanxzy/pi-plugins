import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, auth as runOAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import { discoverCatalog, type ServerCatalog } from "./catalog.ts";
import { createDefaultAuthStore } from "./auth-store.ts";
import { PiOAuthProvider, ensureCallbackServer, waitForOAuthCallback, cancelOAuthCallback, stopCallbackServer, stopCallbackServerIfIdle, type OAuthProviderOptions } from "./oauth.ts";
import type { McpRemoteServerConfig, McpTimeoutConfig } from "./config.ts";
import { pathToFileURL } from "node:url";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MCP_OPERATIONS, processWithLog } from "@xzy-ai/observability";

const DEFAULT_TIMEOUT = 30_000;

export type RemoteStatus =
  | { status: "connected" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" }
  | { status: "needs_client_registration"; error: string };

export interface RemoteConnectionResult {
  status: RemoteStatus;
  catalog: ServerCatalog;
  transport?: "streamable-http" | "sse";
  client?: Client;
}

export interface ConnectRemoteOptions {
  url: string;
  agentDir: string;
  projectRoot?: string;
  /** Owner (Pi session) for transient OAuth-flow isolation. */
  ownerKey?: string;
  headers?: Record<string, string>;
  oauth?: McpRemoteServerConfig["oauth"];
  timeout?: McpTimeoutConfig;
  signal?: AbortSignal;
  onRedirect: (url: URL) => void | Promise<void>;
  store?: ReturnType<typeof createDefaultAuthStore>;
}

type RemoteTransport = StreamableHTTPClientTransport | SSEClientTransport;

interface PendingRemoteAuth {
  provider: PiOAuthProvider;
  state: string;
  authorizationUrl: string;
  callback: Promise<string>;
}

const pendingRemoteAuth = new Map<string, PendingRemoteAuth>();

function authKey(ownerKey: string | undefined, url: string): string {
  return ownerKey ? `${ownerKey}\u0000${url}` : url;
}

function getTimeout(timeout: McpTimeoutConfig | undefined, type: "startup" | "request"): number {
  return timeout?.[type] ?? DEFAULT_TIMEOUT;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAuthenticationError(error: unknown): boolean {
  return (
    error instanceof UnauthorizedError ||
    /unauthorized|access.denied|authentication.required|client registration|oauth/i.test(messageOf(error))
  );
}

function authRegistrationError(error: unknown): boolean {
  return /registration|client[_ -]?id|dynamic/i.test(messageOf(error));
}

function createClient(projectRoot?: string): Client {
  const client = new Client({ name: "pi-c2", version: "0.1.0" }, { capabilities: { roots: {} } });
  if (projectRoot) {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(projectRoot).href }] }));
  }
  return client;
}

function makeProvider(options: ConnectRemoteOptions): PiOAuthProvider | undefined {
  if (options.oauth === false) return undefined;
  const config = typeof options.oauth === "object" ? options.oauth : undefined;
  const providerOptions: OAuthProviderOptions = {
    serverUrl: options.url,
    agentDir: options.agentDir,
    ownerKey: options.ownerKey,
    store: options.store ? () => options.store! : undefined,
    clientId: config?.client_id,
    clientSecret: config?.client_secret,
    scope: config?.scope,
    callbackPort: config?.callback_port,
    redirectUri: config?.redirect_uri,
    onRedirect: options.onRedirect,
  };
  return new PiOAuthProvider(providerOptions);
}

async function connectTransport(
  transport: RemoteTransport,
  projectRoot: string | undefined,
  timeout: number,
  requestTimeout: number,
  signal: AbortSignal | undefined,
): Promise<{ client: Client; catalog: ServerCatalog }> {
  const client = createClient(projectRoot);
  const started = client.connect(transport, {
    timeout,
    resetTimeoutOnProgress: true,
    ...(signal ? { signal } : {}),
  });
  let abortReject: ((error: Error) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abortReject = reject;
  });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void transport.close().catch(() => undefined);
      reject(new Error(`MCP remote startup timed out after ${timeout}ms`));
    }, timeout);
    timer.unref();
  });
  const onAbort = (): void => {
    void transport.close().catch(() => undefined);
    abortReject?.(new Error("MCP remote connection aborted"));
  };
  if (signal) {
    if (signal.aborted) {
      void transport.close().catch(() => undefined);
      throw new Error("MCP remote connection aborted");
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    await Promise.race([started, deadline, aborted]);
    let requestTimer: NodeJS.Timeout | undefined;
    const requestDeadline = new Promise<never>((_, reject) => {
      requestTimer = setTimeout(() => {
        void transport.close().catch(() => undefined);
        reject(new Error(`MCP remote request timed out after ${requestTimeout}ms`));
      }, requestTimeout);
      requestTimer.unref();
    });
    try {
      const catalog = await Promise.race([discoverCatalog(client, requestTimeout, signal), requestDeadline]);
      return { client, catalog };
    } finally {
      if (requestTimer) clearTimeout(requestTimer);
    }
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Connect a remote MCP server with Streamable HTTP first and SSE fallback.
 * Authentication errors stop fallback because switching transports cannot fix
 * credentials; ordinary transport errors permit the legacy SSE attempt.
 */
export async function connectRemote(options: ConnectRemoteOptions): Promise<RemoteConnectionResult> {
  return processWithLog({ operation: MCP_OPERATIONS.CONNECT_REMOTE, parameters: { url: options.url } }, async () => {
  let url: URL;
  try {
    url = new URL(options.url);
  } catch {
    return { status: { status: "failed", error: "Invalid MCP URL" }, catalog: emptyCatalog() };
  }
  const provider = makeProvider(options);
  const requestInit = options.headers ? { headers: options.headers } : undefined;
  const transports: Array<{ kind: "streamable-http" | "sse"; transport: RemoteTransport }> = [
    {
      kind: "streamable-http",
      transport: new StreamableHTTPClientTransport(url, { authProvider: provider, requestInit }),
    },
    {
      kind: "sse",
      transport: new SSEClientTransport(url, { authProvider: provider, requestInit }),
    },
  ];

  let lastError = "Remote MCP connection failed";
  for (const candidate of transports) {
    try {
      const connected = await connectTransport(
        candidate.transport,
        options.projectRoot,
        getTimeout(options.timeout, "startup"),
        getTimeout(options.timeout, "request"),
        options.signal,
      );
      // Automatic OAuth during connect: persist any tokens the SDK exchanged
      // via saveTokens so they survive the next connection.
      if (provider) await provider.commit().catch(() => undefined);
      return {
        status: { status: "connected" },
        catalog: connected.catalog,
        transport: candidate.kind,
        client: connected.client,
      };
    } catch (error) {
      lastError = messageOf(error);
      await candidate.transport.close().catch(() => undefined);
      if (isAuthenticationError(error)) {
        if (provider) {
          // Automatic OAuth during connect: persist any tokens the SDK
          // exchanged via saveTokens so they survive the next connection.
          await provider.commit().catch(() => undefined);
        }
        return authRegistrationError(error)
          ? { status: { status: "needs_client_registration", error: "Provide a pre-registered OAuth client ID" }, catalog: emptyCatalog() }
          : { status: { status: "needs_auth" }, catalog: emptyCatalog() };
      }
      // A bounded startup/request cancellation is already a terminal result;
      // retrying another transport would duplicate work and delay the caller.
      if (/MCP remote (startup|request) timed out|MCP remote connection aborted/i.test(lastError)) {
        return { status: { status: "failed", error: lastError }, catalog: emptyCatalog() };
      }
    }
  }
  return { status: { status: "failed", error: lastError }, catalog: emptyCatalog() };
  });
}

/** Begin OAuth discovery and capture the authorization URL for a remote server. */
export async function startRemoteAuth(
  options: ConnectRemoteOptions,
): Promise<{ authorizationUrl: string; provider: PiOAuthProvider; state: string; callback: Promise<string> }> {
  return processWithLog({ operation: MCP_OPERATIONS.CONNECT_REMOTE, parameters: { url: options.url, auth: true } }, async () => {
  const provider = makeProvider(options);
  if (!provider) throw new Error("OAuth is disabled for this remote server");
  const key = authKey(options.ownerKey, options.url);
  const existing = pendingRemoteAuth.get(key);
  if (existing) {
    // A flow is already in flight for this server; reuse it rather than
    // orphaning the earlier callback until its 5-minute timeout.
    return {
      authorizationUrl: existing.authorizationUrl,
      provider: existing.provider,
      state: existing.state,
      callback: existing.callback,
    };
  }
  const callbackBinding = await ensureCallbackServer(provider.redirectUrl);
  let effectiveRedirectUri = provider.redirectUrl;
  const effectiveUrl = new URL(effectiveRedirectUri);
  if (effectiveUrl.port === "0") {
    effectiveUrl.port = String(callbackBinding.port);
    effectiveRedirectUri = effectiveUrl.toString();
  }
  let redirect: URL | undefined;
  const redirecting = new PiOAuthProvider({
    serverUrl: options.url,
    agentDir: options.agentDir,
    ownerKey: options.ownerKey,
    store: options.store ? () => options.store! : undefined,
    clientId: typeof options.oauth === "object" ? options.oauth.client_id : undefined,
    clientSecret: typeof options.oauth === "object" ? options.oauth.client_secret : undefined,
    scope: typeof options.oauth === "object" ? options.oauth.scope : undefined,
    callbackPort: callbackBinding.port,
    redirectUri: effectiveRedirectUri,
    onRedirect: async (url) => {
      redirect = url;
      await options.onRedirect(url);
    },
  });
  let result: Awaited<ReturnType<typeof runOAuth>>;
  try {
    result = await runOAuth(redirecting, { serverUrl: options.url });
  } catch (error) {
    // No callback is pending when discovery/exchange fails before the browser
    // flow is registered. Do not leave a process-wide listener behind.
    stopCallbackServerIfIdle();
    throw error;
  }
  if (result === "AUTHORIZED") await redirecting.commit();
  if (!redirect) {
    stopCallbackServerIfIdle();
    throw new Error("OAuth provider did not return an authorization URL");
  }
  const state = redirect.searchParams.get("state");
  if (!state) {
    stopCallbackServerIfIdle();
    throw new Error("OAuth authorization URL did not include a state parameter");
  }
  // Register the loopback callback so the browser redirect resolves the
  // authorization code for finishRemoteAuth. Swallow cancellation so a logout
  // or shutdown never surfaces an unhandled rejection.
  const callback = waitForOAuthCallback(state, options.url, options.ownerKey);
  callback.catch(() => undefined);
  pendingRemoteAuth.set(key, {
    provider: redirecting,
    state,
    authorizationUrl: redirect.toString(),
    callback,
  });
  // Any settled callback ends the flow (finished, cancelled, or timed out).
  // Drop the map entry once consumers have had their turn so a later /mcp
  // auth starts a fresh flow instead of reusing a dead one.
  callback.then(undefined, () => {
    // Rejected callbacks are cancelled or timed out and cannot be finished;
    // successful callbacks remain indexed until finishRemoteAuth commits them.
    if (pendingRemoteAuth.get(key)?.callback === callback) {
      pendingRemoteAuth.delete(key);
    }
  });
  return { authorizationUrl: redirect.toString(), provider: redirecting, state, callback };
  });
}

/** Finish a pending OAuth flow and commit credentials only after success. */
export async function finishRemoteAuth(
  options: ConnectRemoteOptions,
  authorizationCode?: string,
): Promise<void> {
  return processWithLog({
    operation: MCP_OPERATIONS.AUTH_STORE,
    parameters: { url: options.url, action: "finish" },
  }, async () => {
  const key = authKey(options.ownerKey, options.url);
  const pending = pendingRemoteAuth.get(key);
  const provider = pending?.provider ?? makeProvider(options);
  if (!provider) throw new Error("OAuth is disabled for this remote server");
  const code = authorizationCode ?? (pending ? await pending.callback : undefined);
  if (!code) throw new Error("No OAuth authorization code is pending");
  if (pending) cancelOAuthCallback(options.url, options.ownerKey);
  try {
    const result = await runOAuth(provider, { serverUrl: options.url, authorizationCode: code });
    if (result !== "AUTHORIZED") throw new Error("OAuth authorization did not complete");
    await provider.commit();
    pendingRemoteAuth.delete(key);
  } catch (error) {
    // A failed finish must not leave a dead flow behind: cancel the callback,
    // drop the entry, and stop the listener when nothing else is pending.
    if (pending) {
      cancelOAuthCallback(options.url, options.ownerKey);
      pendingRemoteAuth.delete(key);
    }
    stopCallbackServerIfIdle();
    throw error;
  }
  });
}

/** Clear stored credentials and cancel any pending callback for a remote URL. */
export function logoutRemote(options: ConnectRemoteOptions): void {
  processWithLog({
    operation: MCP_OPERATIONS.AUTH_STORE,
    parameters: { url: options.url, action: "logout" },
  }, () => {
    const provider = makeProvider(options);
    provider?.clear();
    cancelPendingAuth(options.url, options.ownerKey);
  });
}

/** Cancel a pending callback for a single remote URL without global teardown. */
export function cancelRemoteAuth(url: string, ownerKey?: string): void {
  processWithLog({
    operation: MCP_OPERATIONS.AUTH_STORE,
    parameters: { url, action: "cancel" },
  }, () => {
    cancelPendingAuth(url, ownerKey);
  });
}

/** Stop the callback server and clear all pending auth, used on session shutdown. */
export async function teardownRemoteAuth(ownerKey?: string): Promise<void> {
  return processWithLog({
    operation: MCP_OPERATIONS.AUTH_STORE,
    parameters: { action: "teardown", ownerKey },
  }, async () => {
  const prefix = ownerKey ? `${ownerKey}\u0000` : undefined;
  for (const [key, pending] of pendingRemoteAuth) {
    if (prefix && !key.startsWith(prefix)) continue;
    cancelOAuthCallback(pending.provider.serverUrl, ownerKey);
    pendingRemoteAuth.delete(key);
  }
  if (!ownerKey) pendingRemoteAuth.clear();
  stopCallbackServerIfIdle();
  });
}

function cancelPendingAuth(url: string, ownerKey?: string): void {
  const key = authKey(ownerKey, url);
  const pending = pendingRemoteAuth.get(key);
  if (pending) {
    cancelOAuthCallback(url, ownerKey);
    pendingRemoteAuth.delete(key);
  }
}

function emptyCatalog(): ServerCatalog {
  return { tools: [], prompts: [], resources: [], resourceTemplates: [] };
}

export { PiOAuthProvider } from "./oauth.ts";