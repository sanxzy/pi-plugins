import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { createDefaultAuthStore, type AuthStore } from "./auth-store.ts";

export const OAUTH_CALLBACK_PORT = 19876;
export const OAUTH_CALLBACK_PATH = "/mcp/oauth/callback";
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
/** Injectable expiry for abandoned OAuth flows (tests use milliseconds). */
export let oauthCallbackTimeoutMs = CALLBACK_TIMEOUT_MS;
export function setOAuthCallbackTimeout(timeoutMs: number): void {
  oauthCallbackTimeoutMs = timeoutMs;
}
export function resetOAuthCallbackTimeout(): void {
  oauthCallbackTimeoutMs = CALLBACK_TIMEOUT_MS;
}
const CALLBACK_HOST = "127.0.0.1";

/** Parse a redirect URI into a loopback port and path, with safe defaults. */
export function parseRedirectUri(redirectUri?: string): { port: number; path: string } {
  if (!redirectUri) return { port: OAUTH_CALLBACK_PORT, path: OAUTH_CALLBACK_PATH };
  try {
    const url = new URL(redirectUri);
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    return { port: Number.isInteger(port) ? port : OAUTH_CALLBACK_PORT, path: url.pathname || OAUTH_CALLBACK_PATH };
  } catch {
    return { port: OAUTH_CALLBACK_PORT, path: OAUTH_CALLBACK_PATH };
  }
}

export interface OAuthProviderOptions {
  serverUrl: string;
  agentDir: string;
  /** Session owner for transient PKCE/state isolation. */
  ownerKey?: string;
  store?: () => AuthStore;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  callbackPort?: number;
  redirectUri?: string;
  onRedirect: (url: URL) => void | Promise<void>;
}

/** Sanitized status rendered without secrets. */
export interface OAuthStatus {
  hasTokens: boolean;
  needsClientRegistration: boolean;
  reauthRequired: boolean;
}

/**
 * Pi-native OAuth client provider. Credentials are URL-scoped in a persistent
 * store; new tokens are held in a pending slot and only committed to the store
 * after a successful exchange, so a failed reauthentication never replaces
 * previously working credentials.
 */
export class PiOAuthProvider implements OAuthClientProvider {
  private readonly authStore: AuthStore;
  readonly serverUrl: string;
  readonly redirectUrl: string;
  private pendingClientInfo?: OAuthClientInformationFull;
  private pendingTokens?: OAuthTokens;
  private transientCodeVerifier?: string;
  private transientState?: string;

  constructor(private readonly options: OAuthProviderOptions) {
    this.serverUrl = options.serverUrl;
    this.authStore = options.store ? options.store() : createStore(options.agentDir);
    const { port, path } = parseRedirectUri(options.redirectUri);
    this.redirectUrl = options.redirectUri ?? `http://${CALLBACK_HOST}:${options.callbackPort ?? port}${path}`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: "pi-c2",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.options.clientSecret ? "client_secret_post" : "none",
      ...(this.options.scope ? { scope: this.options.scope } : {}),
    };
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    if (this.options.clientId) {
      return { client_id: this.options.clientId, client_secret: this.options.clientSecret };
    }
    if (this.pendingClientInfo) return pendingClientInfoClient(this.pendingClientInfo);
    const entry = this.authStore.getForUrl(this.serverUrl);
    const info = entry?.clientInfo;
    if (!info) return undefined;
    if (info.clientSecretExpiresAt && info.clientSecretExpiresAt < Date.now() / 1000) return undefined;
    return { client_id: info.clientId, client_secret: info.clientSecret };
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    this.pendingClientInfo = info;
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (this.pendingTokens) return this.pendingTokens;
    const entry = this.authStore.getForUrl(this.serverUrl);
    const stored = entry?.tokens;
    if (!stored?.accessToken) return undefined;
    return {
      access_token: stored.accessToken,
      token_type: "Bearer",
      refresh_token: stored.refreshToken,
      expires_in: stored.expiresAt ? Math.max(0, Math.floor(stored.expiresAt - Date.now() / 1000)) : undefined,
      scope: stored.scope,
    };
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.pendingTokens = tokens;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    if (this.options.ownerKey) this.transientCodeVerifier = codeVerifier;
    else this.authStore.update(this.serverUrl, (entry) => ({ ...entry, codeVerifier }));
  }

  async codeVerifier(): Promise<string> {
    const verifier = this.options.ownerKey ? this.transientCodeVerifier : this.authStore.getForUrl(this.serverUrl)?.codeVerifier;
    if (!verifier) throw new Error(`No PKCE code verifier saved for MCP server: ${this.serverUrl}`);
    return verifier;
  }

  async state(): Promise<string> {
    if (this.options.ownerKey) {
      this.transientState ??= randomHex(32);
      return this.transientState;
    }
    const stored = this.authStore.getForUrl(this.serverUrl)?.oauthState;
    if (stored) return stored;
    const next = randomHex(32);
    this.authStore.update(this.serverUrl, (entry) => ({ ...entry, oauthState: next }));
    return next;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.options.onRedirect(authorizationUrl);
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "tokens") {
      // Clear only the pending slot; a failed reauth must never delete
      // previously working committed tokens.
      this.pendingTokens = undefined;
      return;
    }
    if (scope === "all") {
      // SDK recovery after InvalidClient/UnauthorizedClient: invalidate only
      // registration and transactional state. Committed working credentials
      // must survive a failed reauthentication, so keep the stored tokens.
      this.pendingTokens = undefined;
      this.pendingClientInfo = undefined;
      this.authStore.update(this.serverUrl, (entry) => {
        const next = { ...entry };
        delete next.clientInfo;
        delete next.codeVerifier;
        delete next.oauthState;
        return next;
      });
      return;
    }
    this.authStore.update(this.serverUrl, (entry) => {
      const next = { ...entry };
      if (scope === "client") {
        this.pendingClientInfo = undefined;
        delete next.clientInfo;
      }
      if (scope === "verifier") delete next.codeVerifier;
      return next;
    });
  }

  /** Commit pending credentials only if the exchange succeeded and produced a token. */
  async commit(): Promise<void> {
    if (!this.pendingTokens?.access_token) return;
    this.authStore.update(this.serverUrl, (entry) => ({
      ...entry,
      tokens: {
        accessToken: this.pendingTokens!.access_token,
        refreshToken: this.pendingTokens!.refresh_token,
        expiresAt: this.pendingTokens!.expires_in ? Date.now() / 1000 + this.pendingTokens!.expires_in : undefined,
        scope: this.pendingTokens!.scope,
      },
      clientInfo: this.pendingClientInfo ? {
        clientId: this.pendingClientInfo.client_id,
        clientSecret: this.pendingClientInfo.client_secret,
        clientSecretExpiresAt: this.pendingClientInfo.client_secret_expires_at,
      } : entry.clientInfo,
      oauthState: undefined,
      codeVerifier: undefined,
    }));
    this.pendingTokens = undefined;
    this.pendingClientInfo = undefined;
  }

  /** Load previously stored tokens for a client. */
  status(): OAuthStatus {
    const entry = this.authStore.getForUrl(this.serverUrl);
    return {
      hasTokens: Boolean(entry?.tokens?.accessToken),
      needsClientRegistration: !this.options.clientId && !entry?.clientInfo,
      reauthRequired: Boolean(
        entry?.tokens?.accessToken &&
          entry.tokens.expiresAt !== undefined &&
          entry.tokens.expiresAt < Date.now() / 1000,
      ),
    };
  }

  clear(): void {
    this.authStore.remove(this.serverUrl);
  }
}

function pendingClientInfoClient(info: OAuthClientInformationFull): OAuthClientInformation {
  return {
    client_id: info.client_id,
    client_secret: info.client_secret,
    client_id_issued_at: info.client_id_issued_at,
    client_secret_expires_at: info.client_secret_expires_at,
  };
}

function randomHex(bytes: number): string {
  return Array.from(randomBytes(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, bytes * 2);
}

function createStore(agentDir: string): AuthStore {
  return createDefaultAuthStore(agentDir);
}

// --- Loopback callback server -------------------------------------------------

interface PendingAuth {
  resolve: (code: string) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

let callbackServer: ReturnType<typeof createServer> | undefined;
let closingServer: Promise<void> | undefined;
let callbackPort = OAUTH_CALLBACK_PORT;
let callbackPath = OAUTH_CALLBACK_PATH;
const pendingAuths = new Map<string, PendingAuth>();
const stateToUrl = new Map<string, { url: string; ownerKey?: string }>();

async function isPortInUse(port: number): Promise<boolean> {
  if (port === 0) return false;
  return new Promise((resolve) => {
    void import("node:net").then(({ createConnection }) => {
      const socket = createConnection(port, CALLBACK_HOST);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
  });
}

function cleanupStateIndex(state: string): void {
  stateToUrl.delete(state);
}

function stopIfIdle(): void {
  if (pendingAuths.size > 0 || !callbackServer) return;
  const server = callbackServer;
  callbackServer = undefined;
  // closeAllConnections drops undici keep-alive sockets so server.close()
  // resolves immediately instead of waiting for the client's idle timeout.
  server.closeAllConnections();
  closingServer = new Promise<void>((resolve) => server.close(() => resolve()));
}

function ok(server: typeof callbackServer, res: ServerResponse, body: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<html><body><h1>${body}</h1></body></html>`);
}

function bad(server: typeof callbackServer, res: ServerResponse, message: string, code = 400): void {
  res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<html><body><h1>${message}</h1></body></html>`);
}

function handleCallbackRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", `http://${CALLBACK_HOST}:${callbackPort}`);
  if (url.pathname !== callbackPath) {
    bad(callbackServer, res, "Not found", 404);
    return;
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (!state) {
    bad(callbackServer, res, "Missing required state parameter", 400);
    return;
  }
  const pending = pendingAuths.get(state);
  if (error) {
    if (pending) {
      clearTimeout(pending.timeout);
      pendingAuths.delete(state);
      cleanupStateIndex(state);
      pending.reject(new Error(errorDescription ?? error));
    } else if (!pending) {
      // Fall through to generic invalid state below.
    }
    ok(callbackServer, res, errorDescription ?? error);
    stopIfIdle();
    return;
  }
  if (!code) {
    bad(callbackServer, res, "No authorization code provided", 400);
    return;
  }
  if (!pending) {
    bad(callbackServer, res, "Invalid or expired state parameter", 400);
    return;
  }
  clearTimeout(pending.timeout);
  pendingAuths.delete(state);
  cleanupStateIndex(state);
  pending.resolve(code);
  ok(callbackServer, res, "Authorization complete. You can close this window.");
  stopIfIdle();
}

/** Ensure a loopback-only callback server is listening on the configured port/path. */
export async function ensureCallbackServer(redirectUri?: string): Promise<{ port: number; path: string }> {
  const { port, path } = parseRedirectUri(redirectUri);
  if (callbackServer && (callbackPort !== port || callbackPath !== path)) {
    await stopCallbackServer();
  }
  // Wait for an idle-triggered close to finish before probing the port, so a
  // flow started while the previous server is draining gets a live listener.
  if (closingServer) {
    const closing = closingServer;
    closingServer = undefined;
    await closing;
  }
  if (callbackServer) return { port: callbackPort, path: callbackPath };
  if (await isPortInUse(port)) {
    throw new Error(`MCP OAuth callback port ${port} is already in use and cannot be managed by Pi`);
  }
  callbackPort = port;
  callbackPath = path;
  callbackServer = createServer(handleCallbackRequest);
  await new Promise<void>((resolve, reject) => {
    callbackServer!.once("error", reject);
    callbackServer!.listen(callbackPort === 0 ? 0 : callbackPort, CALLBACK_HOST, () => {
      const address = callbackServer!.address();
      if (address && typeof address === "object") callbackPort = address.port;
      resolve();
    });
  });
  return { port: callbackPort, path: callbackPath };
}

/** Register a pending callback for an OAuth state; resolves with the auth code. */
export function waitForOAuthCallback(state: string, url: string, ownerKey?: string): Promise<string> {
  stateToUrl.set(state, { url, ownerKey });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingAuths.has(state)) {
        pendingAuths.delete(state);
        stateToUrl.delete(state);
        reject(new Error("OAuth callback timeout - authorization took too long"));
        stopIfIdle();
      }
    }, oauthCallbackTimeoutMs);
    pendingAuths.set(state, { resolve, reject, timeout });
  });
}

/** Cancel a pending OAuth callback, e.g. on logout or shutdown. */
export function cancelOAuthCallback(url: string, ownerKey?: string): void {
  const state = [...stateToUrl.entries()].find(([, binding]) => binding.url === url && binding.ownerKey === ownerKey)?.[0];
  const pending = state ? pendingAuths.get(state) : undefined;
  if (pending) {
    clearTimeout(pending.timeout);
    pendingAuths.delete(state!);
    stateToUrl.delete(state!);
    pending.reject(new Error("Authorization cancelled"));
    stopIfIdle();
  }
}

/** Stop the callback server when no authorization is pending (failed flows). */
export function stopCallbackServerIfIdle(): void {
  stopIfIdle();
}

/** Stop the callback server and reject any still-pending callbacks. */
export async function stopCallbackServer(): Promise<void> {
  if (closingServer) {
    const closing = closingServer;
    closingServer = undefined;
    await closing;
  }
  if (callbackServer) {
    await new Promise<void>((resolve) => {
      callbackServer!.closeAllConnections();
      callbackServer!.close(() => resolve());
    });
    callbackServer = undefined;
  }
  for (const [, pending] of pendingAuths) {
    clearTimeout(pending.timeout);
    pending.reject(new Error("OAuth callback server stopped"));
  }
  pendingAuths.clear();
  stateToUrl.clear();
}

export function isCallbackServerRunning(): boolean {
  return callbackServer !== undefined;
}