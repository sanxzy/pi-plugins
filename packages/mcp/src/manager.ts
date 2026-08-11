import {
  loadMcpConfig,
  projectConfigPath,
  userConfigPath,
  userAgentDir,
  type McpConfig,
  type McpConfigIssue,
  type McpConfigLoadOptions,
  type McpConfigResult,
} from "./config.ts";

export type McpServerStatus =
  | { status: "configured" }
  | { status: "disabled" }
  | { status: "failed"; error: string };

export interface McpManagerState {
  config?: McpConfig;
  issues: McpConfigIssue[];
  servers: Record<string, McpServerStatus>;
  running: boolean;
}

export interface McpManagerOptions extends McpConfigLoadOptions {
  agentDir?: string;
  projectRoot: string;
  /** Injectable file watcher. Return an idempotent unsubscribe function. */
  watch?: (paths: string[], onChange: () => void) => () => void;
  /** Called after a successful configuration reload. */
  onReload?: (state: McpManagerState) => void;
}

export interface McpManager {
  readonly projectRoot: string;
  readonly configPaths: readonly [string, string];
  state(): McpManagerState;
  reload(): McpConfigResult;
  start(): Promise<McpManagerState>;
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

/**
 * Create the Phase 1 manager shell. It owns configuration state and lifecycle
 * resources but intentionally does not open MCP transports yet.
 */
export function createMcpManager(options: McpManagerOptions): McpManager {
  const agentDir = userAgentDir(options.agentDir);
  const projectRoot = options.projectRoot;
  const configPaths = [userConfigPath(agentDir), projectConfigPath(projectRoot)] as const;
  let state: McpManagerState = { issues: [], servers: {}, running: false };
  let unsubscribe: (() => void) | undefined;
  let operation: Promise<unknown> = Promise.resolve();

  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = operation.then(task, task);
    operation = next.catch(() => undefined);
    return next;
  };

  const reload = (): McpConfigResult => {
    const result = loadMcpConfig(agentDir, projectRoot, options);
    state = stateFor(result, state.running);
    options.onReload?.(state);
    return result;
  };

  const start = (): Promise<McpManagerState> =>
    serialize(async () => {
      reload();
      state = { ...state, running: true };
      if (!unsubscribe && options.watch) {
        unsubscribe = options.watch([...configPaths], () => {
          reload();
        });
      }
      return state;
    });

  const stop = (): Promise<void> =>
    serialize(async () => {
      const current = unsubscribe;
      unsubscribe = undefined;
      current?.();
      state = { ...state, running: false };
    });

  return { projectRoot, configPaths, state: () => state, reload, start, stop };
}
