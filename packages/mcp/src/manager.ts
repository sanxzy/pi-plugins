import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { listClientTools } from "./catalog.ts";
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
} from "./config.ts";

const DEFAULT_STARTUP_TIMEOUT = 30_000;
const DEFAULT_REQUEST_TIMEOUT = 30_000;

export type McpServerStatus =
  | { status: "configured" }
  | { status: "disabled" }
  | { status: "connected"; toolCount: number }
  | { status: "failed"; error: string };

export interface McpConnectionResult {
  status: McpServerStatus;
  tools: Tool[];
}

interface ActiveConnection {
  client: Client;
  transport: StdioClientTransport;
  tools: Tool[];
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
  watch?: (paths: string[], onChange: () => void) => () => void;
  onReload?: (state: McpManagerState) => void;
}

export interface McpManager {
  readonly projectRoot: string;
  readonly configPaths: readonly [string, string];
  state(): McpManagerState;
  status(name: string): McpServerStatus | undefined;
  reload(): McpConfigResult;
  start(): Promise<McpManagerState>;
  connectLocal(name: string, server: McpLocalServerConfig): Promise<McpConnectionResult>;
  close(): Promise<void>;
  stop(): Promise<void>;
}

function stateFor(result: McpConfigResult, running: boolean): McpManagerState {
  if (!result.ok) return { issues: [], servers: {}, running };
  const servers = Object.fromEntries(
    Object.entries(result.value.servers).map(([name, server]) => [
      name,
      server.disabled === true ? ({ status: "disabled" } as const) : ({ status: "configured" } as const),
    ]),
  );
  return { config: result.value, issues: result.issues, servers, running };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, onTimeout: () => Promise<void>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void onTimeout().finally(() => reject(new Error(`MCP operation timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    timer.unref();
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function closeConnection(connection: ActiveConnection): Promise<void> {
  await Promise.allSettled([connection.client.close(), connection.transport.close()]);
}

/** Create the session-scoped MCP manager and its Phase 2 local connection boundary. */
export function createMcpManager(options: McpManagerOptions): McpManager {
  const agentDir = userAgentDir(options.agentDir);
  const projectRoot = options.projectRoot;
  const configPaths = [userConfigPath(agentDir), projectConfigPath(projectRoot)] as const;
  let state: McpManagerState = { issues: [], servers: {}, running: false };
  let unsubscribe: (() => void) | undefined;
  let operation: Promise<unknown> = Promise.resolve();
  const connections = new Map<string, ActiveConnection>();

  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = operation.then(task, task);
    operation = next.catch(() => undefined);
    return next;
  };

  const setStatus = (name: string, status: McpServerStatus): void => {
    state = { ...state, servers: { ...state.servers, [name]: status } };
  };

  const reload = (): McpConfigResult => {
    const result = loadMcpConfig(agentDir, projectRoot, options);
    state = stateFor(result, state.running);
    options.onReload?.(state);
    return result;
  };

  const connectLocalInternal = async (name: string, server: McpLocalServerConfig): Promise<McpConnectionResult> => {
      const old = connections.get(name);
      if (old) {
        connections.delete(name);
        await closeConnection(old);
      }
      if (server.disabled === true) {
        const disabled = { status: "disabled" } as const;
        setStatus(name, disabled);
        return { status: disabled, tools: [] };
      }

      const [command, ...args] = server.command;
      const transport = new StdioClientTransport({
        command,
        args,
        cwd: resolveLocalCwd(server, projectRoot),
        env: resolveLocalEnvironment(server, options.env),
        stderr: "pipe",
      });
      const client = new Client(
        { name: "pi-code-mcp", version: "0.1.0" },
        { capabilities: { roots: {} } },
      );
      client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(projectRoot).href }] }));
      const candidate: ActiveConnection = { client, transport, tools: [] };
      const timeout = server.timeout?.startup ?? DEFAULT_STARTUP_TIMEOUT;
      try {
        await withTimeout(client.connect(transport), timeout, () => closeConnection(candidate));
        let tools: Tool[] = [];
        if (client.getServerCapabilities()?.tools) {
          tools = await listClientTools(client, server.timeout?.request ?? DEFAULT_REQUEST_TIMEOUT);
        }
        candidate.tools = tools;
        connections.set(name, candidate);
        const connected = { status: "connected", toolCount: tools.length } as const;
        setStatus(name, connected);
        return { status: connected, tools };
      } catch (error) {
        await closeConnection(candidate);
        const failed = { status: "failed", error: errorMessage(error) } as const;
        setStatus(name, failed);
        return { status: failed, tools: [] };
      }
    };

  const connectLocal = (name: string, server: McpLocalServerConfig): Promise<McpConnectionResult> =>
    serialize(() => connectLocalInternal(name, server));

  const closeInternal = async (): Promise<void> => {
    const active = [...connections.entries()];
    connections.clear();
    await Promise.all(active.map(([, connection]) => closeConnection(connection)));
    for (const name of state.config ? Object.keys(state.config.servers) : Object.keys(state.servers)) {
      setStatus(name, { status: "disabled" });
    }
  };

  const close = (): Promise<void> => serialize(closeInternal);

  const start = (): Promise<McpManagerState> =>
    serialize(async () => {
      reload();
      state = { ...state, running: true };
      if (!unsubscribe && options.watch) {
        unsubscribe = options.watch([...configPaths], () => {
          reload();
        });
      }
      for (const [name, server] of Object.entries(state.config?.servers ?? {})) {
        if (server.type === "local") await connectLocalInternal(name, server);
      }
      return state;
    });

  const stop = (): Promise<void> =>
    serialize(async () => {
      const current = unsubscribe;
      unsubscribe = undefined;
      current?.();
      await closeInternal();
      state = { ...state, running: false };
    });

  return {
    projectRoot,
    configPaths,
    state: () => state,
    status: (name) => state.servers[name],
    reload,
    start,
    connectLocal,
    close,
    stop,
  };
}
