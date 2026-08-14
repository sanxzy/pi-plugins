import { existsSync, statSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MCP_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import {
  ListRootsRequestSchema,
  type CallToolResult,
  type GetPromptResult,
  type Prompt,
  type ReadResourceResult,
  type Resource,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { discoverCatalog, wireListChangedHandlers, type ServerCatalog } from "./catalog.ts";
import {
  loadMcpConfig,
  projectConfigPath,
  resolveLocalCwd,
  resolveLocalEnvironment,
  userConfigPath,
  userAgentDir,
  type McpConfig,
  type McpConfigIssue,
  type McpConfigLoadOptions,
  type McpConfigResult,
  type McpLocalServerConfig,
  type McpRemoteServerConfig,
  type McpTimeoutConfig,
} from "./config.ts";
import { ProcessStdioTransport } from "./stdio.ts";
import { connectRemote as connectRemoteTransport, teardownRemoteAuth, type RemoteStatus } from "./remote.ts";
const DEFAULT_STARTUP_TIMEOUT = 30_000;
const DEFAULT_REQUEST_TIMEOUT = 30_000;

export type McpErrorCategory =
  | "none"
  | "configuration"
  | "startup"
  | "discovery"
  | "transport"
  | "authentication"
  | "client_registration"
  | "timeout"
  | "cancelled"
  | "unknown";

export type McpServerStatus =
  | { status: "configured"; errorCategory: "none" }
  | { status: "disabled"; errorCategory: "none" }
  | { status: "connected"; toolCount: number; errorCategory: "none" }
  | { status: "failed"; error: string; errorCategory: Exclude<McpErrorCategory, "none"> }
  | { status: "needs_auth"; errorCategory: "authentication" }
  | { status: "needs_client_registration"; error: string; errorCategory: "client_registration" };

export interface McpConnectionResult {
  status: McpServerStatus;
  tools: Tool[];
  catalog: ServerCatalog;
}

interface ActiveConnection {
  client: Client;
  transport?: { close(): Promise<void>; onclose?: () => void; onerror?: (error: Error) => void };
  catalog: ServerCatalog;
  /** Whether this connection uses a remote (streamable-http/sse) transport. */
  remote?: boolean;
}

export interface McpManagerState {
  config?: McpConfig;
  issues: McpConfigIssue[];
  servers: Record<string, McpServerStatus>;
  running: boolean;
}

export interface McpManagerOptions extends McpConfigLoadOptions {
  agentDir?: string;
  projectRoot: string;
  /** Stable owner key for transient OAuth lifecycle state. */
  ownerKey?: string;
  watch?: (paths: string[], onChange: () => void) => () => void;
  onReload?: (state: McpManagerState) => void;
  /** Invoked when a connected server reports a list-changed notification. */
  onCatalogChanged?: (name: string) => void;
  /** Invoked after a watched configuration change is reconciled. */
  onConfigChanged?: (names: string[]) => void;
  /** Invoked when one live connection changes state. */
  onServerChanged?: (name: string) => void;
  /** Debounce delay (ms) for config-change reconciliation. Defaults to 500. */
  reloadDebounceMs?: number;
  /** Base backoff delay (ms) for reconnect retries. Defaults to 2_000. */
  reconnectBaseDelayMs?: number;
  /** Max reconnect attempts before giving up. Defaults to 5. */
  reconnectMaxAttempts?: number;
}

export interface McpManager {
  readonly projectRoot: string;
  readonly configPaths: readonly [string, string];
  state(): McpManagerState;
  status(name: string): McpServerStatus | undefined;
  reload(): McpConfigResult;
  reconcile(names?: string[]): Promise<McpManagerState>;
  start(): Promise<McpManagerState>;
  connectLocal(name: string, server: McpLocalServerConfig, signal?: AbortSignal): Promise<McpConnectionResult>;
  connectRemote(name: string, server: McpRemoteServerConfig, signal?: AbortSignal): Promise<McpConnectionResult>;
  disconnect(name: string): Promise<void>;
  /** Active connected server names. */
  serverNames(): string[];
  /** The connected catalog for a server, or undefined when not connected. */
  toolsFor(name: string): Tool[] | undefined;
  /** Invoke a native tool on a connected server, routing the original name. */
  callTool(name: string, nativeName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>;
  promptsFor(name: string): Prompt[] | undefined;
  resourcesFor(name: string): Resource[] | undefined;
  getPrompt(name: string, nativeName: string, args: Record<string, string>, signal?: AbortSignal): Promise<GetPromptResult>;
  readResource(name: string, uri: string, signal?: AbortSignal): Promise<ReadResourceResult>;
  /** Re-discover a connected server's catalogs and bump its revision. */
  refreshCatalog(name: string, signal?: AbortSignal): Promise<ServerCatalog | undefined>;
  close(): Promise<void>;
  stop(): Promise<void>;
}

function stateFor(result: McpConfigResult, running: boolean): McpManagerState {
  if (!result.ok) return { issues: [], servers: {}, running };
  const servers = Object.fromEntries(
    Object.entries(result.value.servers).map(([name, server]) => [
      name,
      server.disabled === true
        ? ({ status: "disabled", errorCategory: "none" as const } as const)
        : ({ status: "configured", errorCategory: "none" as const } as const),
    ]),
  );
  return { config: result.value, issues: result.issues, servers, running };
}

function existingWatchDirectory(path: string): string | undefined {
  let current = dirname(path);
  while (current !== dirname(current)) {
    try {
      if (statSync(current).isDirectory()) return current;
    } catch {
      // Walk toward an existing ancestor for files/directories not created yet.
    }
    current = dirname(current);
  }
  return existsSync(current) ? current : undefined;
}

/** Watch both config paths, including files that are created after startup. */
function defaultWatch(paths: readonly string[], onChange: () => void): () => void {
  const watchers: FSWatcher[] = [];
  const directories = new Set(paths.map(existingWatchDirectory).filter((path): path is string => Boolean(path)));
  for (const directory of directories) {
    try {
      const watcher = fsWatch(directory, (_event, changed) => {
        if (!changed) return;
        const name = String(changed);
        const resolved = join(directory, name);
        if (paths.some((path) => resolved === path)) onChange();
      });
      watcher.unref?.();
      watchers.push(watcher);
    } catch {
      // A missing/inaccessible source is reported by config loading; do not
      // terminate the Pi session because a watcher cannot be installed.
    }
  }
  return () => {
    for (const watcher of watchers) watcher.close();
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSessionExpired(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return /session (?:not found|expired|invalid)|invalid session|mcp-session|session id/i.test(message);
}

function errorCategory(error: unknown): Exclude<McpErrorCategory, "none"> {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("timed out") || message.includes("timeout")) return "timeout";
  if (message.includes("abort") || message.includes("cancel")) return "cancelled";
  if (message.includes("auth") || message.includes("unauthorized") || message.includes("forbidden")) return "authentication";
  if (message.includes("registration")) return "client_registration";
  if (message.includes("discover") || message.includes("list")) return "discovery";
  if (message.includes("connect") || message.includes("transport") || message.includes("session")) return "transport";
  return "startup";
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, onTimeout: () => Promise<void>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void onTimeout();
      reject(new Error(`MCP operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
  });
  return Promise.race([
    operation.finally(() => {
      settled = true;
    }),
    timeout,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function closeConnection(connection: ActiveConnection): Promise<void> {
  await Promise.allSettled([
    connection.client.close(),
    connection.transport ? connection.transport.close() : Promise.resolve(),
  ]);
}

/** Resolve a timeout from server, then global config, then default. */
function resolveTimeout(
  serverTimeout: McpTimeoutConfig | undefined,
  globalTimeout: McpTimeoutConfig | undefined,
  which: "startup" | "request",
): number {
  const value = serverTimeout?.[which] ?? globalTimeout?.[which];
  return value ?? (which === "startup" ? DEFAULT_STARTUP_TIMEOUT : DEFAULT_REQUEST_TIMEOUT);
}

/** Create the session-scoped MCP manager and its Phase 2 local connection boundary. */
export function createMcpManager(options: McpManagerOptions): McpManager {
  const agentDir = userAgentDir(options.agentDir);
  const projectRoot = options.projectRoot;
  const configPaths = [userConfigPath(agentDir), projectConfigPath(projectRoot)] as const;
  let state: McpManagerState = { issues: [], servers: {}, running: false };
  let unsubscribe: (() => void) | undefined;
  let operation: Promise<unknown> = Promise.resolve();
  let reloadTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  let generation = 0;
  let managerAbortController = new AbortController();
  const connections = new Map<string, ActiveConnection>();
  const reconnectTimers = new Map<string, NodeJS.Timeout>();
  const reconnectAttempts = new Map<string, number>();
  const reloadDebounceMs = options.reloadDebounceMs ?? 500;
  const reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 2_000;
  const reconnectMaxAttempts = options.reconnectMaxAttempts ?? 5;

  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = operation.then(task, task);
    operation = next.catch(() => undefined);
    return next;
  };

  const setStatus = (name: string, status: McpServerStatus): void => {
    state = { ...state, servers: { ...state.servers, [name]: status } };
  };

  const signalFor = (signal?: AbortSignal): AbortSignal => {
    if (!signal) return managerAbortController.signal;
    return AbortSignal.any([managerAbortController.signal, signal]);
  };

  const clearReconnect = (name: string): void => {
    const timer = reconnectTimers.get(name);
    if (timer) clearTimeout(timer);
    reconnectTimers.delete(name);
    reconnectAttempts.delete(name);
  };

  const scheduleReconnect = (name: string): void => {
    if (stopped || reconnectTimers.has(name)) return;
    const scheduledGeneration = generation;
    const attempt = reconnectAttempts.get(name) ?? 0;
    if (attempt >= reconnectMaxAttempts) return;
    const delay = reconnectBaseDelayMs * 2 ** attempt;
    reconnectAttempts.set(name, attempt + 1);
    const timer = setTimeout(() => {
      reconnectTimers.delete(name);
      const server = state.config?.servers[name];
      if (stopped || scheduledGeneration !== generation || !server || server.disabled === true) return;
      void processWithLog({
        operation: MCP_OPERATIONS.RECONNECT,
        parameters: { server: name, attempt },
      }, () => serialize(async () => {
        const result = server.type === "local"
          ? await connectLocalInternal(name, server)
          : await connectRemoteInternal(name, server);
        if (result.status.status === "connected") {
          clearReconnect(name);
          options.onServerChanged?.(name);
        } else scheduleReconnect(name);
      })).catch(() => scheduleReconnect(name));
    }, delay);
    timer.unref();
    reconnectTimers.set(name, timer);
  };

  const attachConnectionLifecycle = (name: string, candidate: ActiveConnection): void => {
    const fail = (message: string): void => {
      if (stopped || connections.get(name) !== candidate) return;
      connections.delete(name);
      setStatus(name, { status: "failed", error: message, errorCategory: "transport" });
      void closeConnection(candidate).catch(() => undefined);
      scheduleReconnect(name);
      options.onServerChanged?.(name);
    };
    candidate.client.onclose = () => fail("MCP connection closed");
    candidate.client.onerror = (error) => fail(errorMessage(error));

  };

  const reloadInternal = (): McpConfigResult => {
    const previousConfig = state.config;
    const previousServers = state.servers;
    const result = loadMcpConfig(agentDir, projectRoot, options);
    const next = stateFor(result, state.running);
    if (result.ok && previousConfig) {
      for (const name of connections.keys()) {
        if (JSON.stringify(previousConfig.servers[name]) === JSON.stringify(result.value.servers[name]) && previousServers[name]?.status === "connected") {
          next.servers[name] = previousServers[name]!;
        }
      }
    }
    state = next;
    options.onReload?.(state);
    return result;
  };

  const reload = (): McpConfigResult => processWithLog({ operation: MCP_OPERATIONS.RELOAD }, () => reloadInternal());

  const scheduleConfigReload = (): void => {
    if (stopped) return;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = undefined;
      const before = new Map(Object.entries(state.config?.servers ?? {}).map(([name, server]) => [name, JSON.stringify(server)]));
      reload();
      const after = new Map(Object.entries(state.config?.servers ?? {}).map(([name, server]) => [name, JSON.stringify(server)]));
      const names = [...new Set([...before.keys(), ...after.keys()])].filter((name) => before.get(name) !== after.get(name));
      if (names.length) void reconcile(names).then(() => options.onConfigChanged?.(names), () => undefined);
    }, reloadDebounceMs);
    reloadTimer.unref();
  };

  const connectLocalInternal = async (
    name: string,
    server: McpLocalServerConfig,
    signal?: AbortSignal,
  ): Promise<McpConnectionResult> => {
    const old = connections.get(name);
    if (old) {
      connections.delete(name);
      await closeConnection(old);
    }
    if (server.disabled === true) {
      const disabled = { status: "disabled", errorCategory: "none" } as const;
      setStatus(name, disabled);
      return { status: disabled, tools: [], catalog: { tools: [], prompts: [], resources: [], resourceTemplates: [] } };
    }

    const [command, ...args] = server.command;
    const transport = new ProcessStdioTransport({
      command,
      args,
      cwd: resolveLocalCwd(server, projectRoot),
      env: resolveLocalEnvironment(server, options.env),
      stderr: "pipe",
    });
    const client = new Client(
      { name: "pi-c2-mcp", version: "0.1.0" },
      { capabilities: { roots: {} } },
    );
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(projectRoot).href }] }));
    const candidate: ActiveConnection = { client, transport, catalog: emptyCatalog() };
    const startupTimeout = resolveTimeout(server.timeout, state.config?.timeout, "startup");
    const requestTimeout = resolveTimeout(server.timeout, state.config?.timeout, "request");
    try {
      await withTimeout(client.connect(transport, { signal: signalFor(signal) }), startupTimeout, () =>
        closeConnection(candidate),
      );
      candidate.catalog = await discoverCatalog(client, requestTimeout, signalFor(signal));
      wireListChangedHandlers(client, candidate.catalog, () => {
        if (!stopped && connections.get(name) === candidate) options.onCatalogChanged?.(name);
      });
      attachConnectionLifecycle(name, candidate);
      connections.set(name, candidate);
      clearReconnect(name);
      const connected = { status: "connected", toolCount: candidate.catalog.tools.length, errorCategory: "none" } as const;
      setStatus(name, connected);
      return {
        status: connected,
        tools: candidate.catalog.tools,
        catalog: candidate.catalog,
      };
    } catch (error) {
      await closeConnection(candidate);
      const failed = { status: "failed", error: errorMessage(error), errorCategory: errorCategory(error) } as const;
      setStatus(name, failed);
      if (!stopped && state.running) scheduleReconnect(name);
      return { status: failed, tools: [], catalog: emptyCatalog() };
    }
  };

  const connectLocal = (
    name: string,
    server: McpLocalServerConfig,
    signal?: AbortSignal,
  ): Promise<McpConnectionResult> => processWithLog({ operation: MCP_OPERATIONS.CONNECT, parameters: { server: name } }, () => serialize(() => connectLocalInternal(name, server, signal)));

  const connectRemoteInternal = async (
    name: string,
    server: McpRemoteServerConfig,
    signal?: AbortSignal,
  ): Promise<McpConnectionResult> => {
    const old = connections.get(name);
    if (old) {
      connections.delete(name);
      await closeConnection(old);
    }
    if (server.disabled === true) {
      const disabled = { status: "disabled", errorCategory: "none" } as const;
      setStatus(name, disabled);
      return { status: disabled, tools: [], catalog: emptyCatalog() };
    }
    const result = await connectRemoteTransport({
      url: server.url,
      agentDir,
      projectRoot,
      ownerKey: options.ownerKey,
      headers: server.headers,
      oauth: server.oauth,
      timeout: server.timeout ?? state.config?.timeout,
      signal: signalFor(signal),
      onRedirect: () => {},
    });
    const status = mapRemoteStatus(result.status);
    setStatus(name, status);
    if (result.status.status === "connected" && result.client) {
      const candidateRemote: ActiveConnection = { client: result.client, catalog: result.catalog, remote: true };
      wireListChangedHandlers(result.client, result.catalog, () => {
        if (!stopped && connections.get(name) === candidateRemote) options.onCatalogChanged?.(name);
      });
      attachConnectionLifecycle(name, candidateRemote);
      connections.set(name, candidateRemote);
      clearReconnect(name);
      const connected = { status: "connected", toolCount: result.catalog.tools.length, errorCategory: "none" } as const;
      setStatus(name, connected);
      return { status: connected, tools: result.catalog.tools, catalog: result.catalog };
    }
    if (status.status === "failed" && !stopped && state.running) scheduleReconnect(name);
    return { status, tools: [], catalog: emptyCatalog() };
  };

  const connectRemote = (
    name: string,
    server: McpRemoteServerConfig,
    signal?: AbortSignal,
  ): Promise<McpConnectionResult> => processWithLog({ operation: MCP_OPERATIONS.CONNECT_REMOTE, parameters: { server: name } }, () => serialize(() => connectRemoteInternal(name, server, signal)));

  const closeInternal = async (): Promise<void> => {
    const active = [...connections.entries()];
    connections.clear();
    await Promise.all(active.map(([, connection]) => closeConnection(connection)));
    await teardownRemoteAuth(options.ownerKey);
    for (const name of state.config ? Object.keys(state.config.servers) : Object.keys(state.servers)) {
      setStatus(name, { status: "disabled", errorCategory: "none" });
    }
  };

  const beginShutdown = (): void => {
    if (stopped) return;
    stopped = true;
    generation += 1;
    managerAbortController.abort();
    const current = unsubscribe;
    unsubscribe = undefined;
    current?.();
    for (const timer of reconnectTimers.values()) clearTimeout(timer);
    reconnectTimers.clear();
    reconnectAttempts.clear();
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = undefined;
  };

  const disconnectInternal = async (name: string): Promise<void> => {
    const connection = connections.get(name);
    connections.delete(name);
    if (connection) await closeConnection(connection);
    if (state.servers[name]) {
      setStatus(
        name,
        state.config?.servers[name]?.disabled === true
          ? { status: "disabled", errorCategory: "none" }
          : { status: "configured", errorCategory: "none" },
      );
    }
  };

  const disconnect = (name: string): Promise<void> => processWithLog({ operation: MCP_OPERATIONS.DISCONNECT, parameters: { server: name } }, () => serialize(() => disconnectInternal(name)));
  const close = (): Promise<void> => processWithLog({ operation: MCP_OPERATIONS.MANAGER_CLOSE, parameters: { mode: "close" } }, () => serialize(async () => {
    beginShutdown();
    await closeInternal();
    state = { ...state, running: false };
  }));

  const callWithRecovery = async <T>(
    name: string,
    initial: ActiveConnection,
    operationFor: (connection: ActiveConnection) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    try {
      return await operationFor(initial);
    } catch (error) {
      if (signal?.aborted || !initial.remote || !isSessionExpired(error)) throw error;
      const server = state.config?.servers[name];
      if (!server || server.type !== "remote") throw error;
      const reconnected = await connectRemoteInternal(name, server, signal);
      if (reconnected.status.status !== "connected") throw error;
      const replacement = connections.get(name);
      if (!replacement) throw error;
      try {
        return await operationFor(replacement);
      } catch (retryError) {
        if (connections.get(name) === replacement) connections.delete(name);
        await closeConnection(replacement);
        const failed = { status: "failed", error: errorMessage(retryError), errorCategory: errorCategory(retryError) } as const;
        setStatus(name, failed);
        scheduleReconnect(name);
        options.onServerChanged?.(name);
        throw retryError;
      }
    }
  };

  const callToolInternal = async (
    name: string,
    nativeName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> => {
    const connection = connections.get(name);
    if (!connection) {
      throw new Error(`MCP server "${name}" is not connected`);
    }
    const requestTimeout = resolveTimeout(
      state.config?.servers[name]?.type === "local"
        ? (state.config.servers[name] as McpLocalServerConfig).timeout
        : state.config?.servers[name]?.type === "remote"
          ? (state.config.servers[name] as McpRemoteServerConfig).timeout
          : undefined,
      state.config?.timeout,
      "request",
    );
    return callWithRecovery(name, connection, (current) =>
      current.client.callTool(
        { name: nativeName, arguments: args },
        undefined,
        {
          timeout: requestTimeout,
          resetTimeoutOnProgress: true,
          onprogress: () => undefined,
          signal: signalFor(signal),
        },
      ) as Promise<CallToolResult>,
      signal,
    );
  };

  const callTool = (
    name: string,
    nativeName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> => processWithLog({ operation: MCP_OPERATIONS.CALL_TOOL, parameters: { server: name, tool: nativeName } }, () => serialize(() => callToolInternal(name, nativeName, args, signal)));

  const requestOptionsFor = (name: string, signal?: AbortSignal) => ({
    timeout: resolveTimeout(
      state.config?.servers[name]?.type === "local"
        ? (state.config.servers[name] as McpLocalServerConfig).timeout
        : state.config?.servers[name]?.type === "remote"
          ? (state.config.servers[name] as McpRemoteServerConfig).timeout
          : undefined,
      state.config?.timeout,
      "request",
    ),
    resetTimeoutOnProgress: true,
    onprogress: () => undefined,
    signal: signalFor(signal),
  });

  const getPromptInternal = async (
    name: string,
    nativeName: string,
    args: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<GetPromptResult> => {
    const connection = connections.get(name);
    if (!connection) throw new Error(`MCP server "${name}" is not connected`);
    return callWithRecovery(name, connection, (current) =>
      current.client.getPrompt({ name: nativeName, arguments: args }, requestOptionsFor(name, signal)),
      signal,
    );
  };

  // The lifecycle layer owns GET_PROMPT/READ_RESOURCE telemetry (normalization
  // + error semantics live there); these manager entry points deliberately do
  // NOT add a second span so one logical read persists exactly one record pair.
  const getPrompt = (
    name: string,
    nativeName: string,
    args: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<GetPromptResult> => serialize(() => getPromptInternal(name, nativeName, args, signal));

  const readResourceInternal = async (
    name: string,
    uri: string,
    signal?: AbortSignal,
  ): Promise<ReadResourceResult> => {
    const connection = connections.get(name);
    if (!connection) throw new Error(`MCP server "${name}" is not connected`);
    return callWithRecovery(name, connection, (current) =>
      current.client.readResource({ uri }, requestOptionsFor(name, signal)),
      signal,
    );
  };

  const readResource = (name: string, uri: string, signal?: AbortSignal): Promise<ReadResourceResult> => serialize(() => readResourceInternal(name, uri, signal));

  const refreshCatalogInternal = async (name: string, signal?: AbortSignal): Promise<ServerCatalog | undefined> => {
    const connection = connections.get(name);
    if (!connection) return undefined;
    const requestTimeout = resolveTimeout(
      state.config?.servers[name]?.type === "local"
        ? (state.config.servers[name] as McpLocalServerConfig).timeout
        : state.config?.servers[name]?.type === "remote"
          ? (state.config.servers[name] as McpRemoteServerConfig).timeout
          : undefined,
      state.config?.timeout,
      "request",
    );
    const catalog = await discoverCatalog(connection.client, requestTimeout, signalFor(signal));
    connection.catalog = catalog;
    wireListChangedHandlers(connection.client, catalog, () => {
      if (!stopped && connections.get(name) === connection) options.onCatalogChanged?.(name);
    });
    setStatus(name, { status: "connected", toolCount: catalog.tools.length, errorCategory: "none" });
    return catalog;
  };

  const refreshCatalog = (name: string, signal?: AbortSignal): Promise<ServerCatalog | undefined> =>
    processWithLog({ operation: MCP_OPERATIONS.REFRESH_CATALOG, parameters: { server: name } }, () => serialize(() => refreshCatalogInternal(name, signal)));

  const reconcileInternal = async (names?: string[]): Promise<McpManagerState> => {
    const configured = state.config?.servers ?? {};
    const scoped = new Set(names ?? [...new Set([...Object.keys(configured), ...connections.keys()])]);
    for (const name of [...connections.keys()]) {
      const server = configured[name];
      if (scoped.has(name) && (!server || server.disabled === true)) await disconnectInternal(name);
    }
    for (const [name, server] of Object.entries(configured)) {
      if (scoped.has(name) && server.type === "local") await connectLocalInternal(name, server);
      else if (scoped.has(name) && server.type === "remote") await connectRemoteInternal(name, server);
    }
    return state;
  };

  const reconcile = (names?: string[]): Promise<McpManagerState> =>
    processWithLog({ operation: MCP_OPERATIONS.RECONCILE, parameters: { servers: names } }, () => serialize(() => reconcileInternal(names)));

  const start = (): Promise<McpManagerState> =>
    processWithLog({ operation: MCP_OPERATIONS.MANAGER_START }, () => serialize(async () => {
      stopped = false;
      managerAbortController = new AbortController();
      reloadInternal();
      state = { ...state, running: true };
      if (!unsubscribe) {
        const watch = options.watch ?? defaultWatch;
        unsubscribe = watch([...configPaths], () => {
          scheduleConfigReload();
        });
      }
      return reconcileInternal();
    }));

  const stop = (): Promise<void> => processWithLog({ operation: MCP_OPERATIONS.MANAGER_STOP, parameters: { mode: "stop" } }, () => serialize(async () => {
    beginShutdown();
    await closeInternal();
    state = { ...state, running: false };
  }));

  return {
    projectRoot,
    configPaths,
    state: () => state,
    status: (name) => state.servers[name],
    reload,
    reconcile,
    start,
    connectLocal,
    connectRemote,
    disconnect,
    serverNames: () => [...connections.keys()],
    toolsFor: (name) => connections.get(name)?.catalog.tools,
    promptsFor: (name) => connections.get(name)?.catalog.prompts,
    resourcesFor: (name) => connections.get(name)?.catalog.resources,
    callTool,
    getPrompt,
    readResource,
    refreshCatalog,
    close,
    stop,
  };
}

function emptyCatalog(): ServerCatalog {
  return { tools: [], prompts: [], resources: [], resourceTemplates: [] };
}

function mapRemoteStatus(status: RemoteStatus): McpServerStatus {
  switch (status.status) {
    case "connected":
      return { status: "connected", toolCount: 0, errorCategory: "none" };
    case "failed":
      return { status: "failed", error: status.error, errorCategory: errorCategory(status.error) };
    case "needs_auth":
      return { status: "needs_auth", errorCategory: "authentication" };
    case "needs_client_registration":
      return { status: "needs_client_registration", error: status.error, errorCategory: "client_registration" };
  }
}