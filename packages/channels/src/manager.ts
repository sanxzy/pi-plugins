import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { CHANNEL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { createChannelOwner, type ChannelOwner, type ChannelOwnerRecord } from "./ownership.ts";
import { type ChannelConfig, type StateResult } from "./state.ts";

/**
 * Injectable Telegram long-polling transport behind the connection manager.
 *
 * The manager depends only on this narrow contract. `start` must return a
 * readiness result and must never be awaited as if it were the long-running
 * polling loop; the loop runs in the background and reports through `onError`.
 */
export interface ChannelPoller {
  /** Begin polling asynchronously and resolve when ready or on failure. */
  start(config: ChannelConfig): Promise<StateResult<void>>;
  /** Stop polling idempotently. */
  stop(): Promise<void>;
  /** Optional error callback for asynchronous polling failures. */
  onError?: (error: unknown) => void;
}

export type ChannelConnectionStatus =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "ready" }
  | { kind: "stopping" }
  | { kind: "failed"; message: string };

export interface ChannelConnectionState {
  status: ChannelConnectionStatus;
  owner?: ChannelOwnerRecord;
  /** True when this process currently owns the project connection. */
  owned: boolean;
}

export interface ChannelManager {
  readonly projectRoot: string;
  readonly owner: ChannelOwner;
  /** Safe current connection state for the host and setup UI. */
  state(): ChannelConnectionState;
  /** Start the connection for a validated config, serialized against other ops. */
  start(config: ChannelConfig): Promise<StateResult<ChannelConnectionState>>;
  /** Stop the connection and release ownership, idempotent. */
  stop(): Promise<void>;
  /** Replace the current listener with a candidate, serialized. */
  replace(config: ChannelConfig): Promise<StateResult<ChannelConnectionState>>;
}

export interface ChannelManagerDeps {
  projectRoot: string;
  /** Injectable poller factory; the manager never imports a Telegram library. */
  createPoller: (config: ChannelConfig) => ChannelPoller;
  owner?: ChannelOwner;
}

/**
 * Resolve equivalent project paths to one canonical identity. Symlinks and
 * relative segments are resolved so two acquisitions of the same project cannot
 * take ownership simultaneously under different spellings.
 */
export function canonicalProjectRoot(input: string): string {
  const absolute = isAbsolute(input) ? input : resolve(process.cwd(), input);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export function createChannelManager(deps: ChannelManagerDeps): ChannelManager {
  const projectRoot = canonicalProjectRoot(deps.projectRoot);
  const owner = deps.owner ?? createChannelOwner(projectRoot);
  let poller: ChannelPoller | undefined;
  let status: ChannelConnectionStatus = { kind: "idle" };
  let operation: Promise<unknown> = Promise.resolve();

  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = operation.then(task, task);
    operation = next.catch(() => undefined);
    return next;
  };

  const setStatus = (next: ChannelConnectionStatus): void => {
    status = next;
  };

  const state = (): ChannelConnectionState => ({
    status,
    owner: owner.read().owner,
    owned: owner.isOwner,
  });

  const stopPoller = async (): Promise<void> => {
    const current = poller;
    poller = undefined;
    if (current) {
      setStatus({ kind: "stopping" });
      try {
        await current.stop();
      } catch {
        // Stop is best-effort; ownership is still released below.
      }
    }
    owner.release();
    setStatus({ kind: "idle" });
  };

  const startInternal = async (config: ChannelConfig): Promise<StateResult<ChannelConnectionState>> => {
    if (poller) {
      // A listener is already active for this project; do not start a second.
      return { ok: false, code: "invalid", message: "Channel connection is already active" };
    }
    const acquired = owner.acquire();
    if (!acquired.ok) {
      setStatus({ kind: "failed", message: acquired.message });
      return { ok: false, code: acquired.code, message: acquired.message };
    }
    setStatus({ kind: "starting" });
    let candidate: ChannelPoller | undefined;
    try {
      candidate = deps.createPoller(config);
      const active = candidate;
      candidate.onError = () => {
        if (poller !== active) return;
        poller = undefined;
        owner.release();
        setStatus({ kind: "failed", message: "Telegram polling stopped unexpectedly" });
        void active.stop().catch(() => undefined);
      };
      // Publish the candidate before startup so an immediately-ending runner
      // still reaches the same cleanup boundary as a later polling failure.
      poller = candidate;
      const started = await candidate.start(config);
      if (!started.ok) {
        poller = undefined;
        owner.release();
        candidate.onError = undefined;
        setStatus({ kind: "failed", message: started.message });
        return { ok: false, code: started.code, message: started.message };
      }
    } catch {
      poller = undefined;
      owner.release();
      setStatus({ kind: "failed", message: "Channel connection failed to start" });
      return { ok: false, code: "io", message: "Channel connection failed to start" };
    }
    poller = candidate;
    setStatus({ kind: "ready" });
    return { ok: true, value: state() };
  };

  const start = (config: ChannelConfig): Promise<StateResult<ChannelConnectionState>> =>
    processWithLog({ operation: CHANNEL_OPERATIONS.MANAGER_START, parameters: { projectRoot } }, () => serialize(() => startInternal(config)));

  const stop = (): Promise<void> => processWithLog({ operation: CHANNEL_OPERATIONS.MANAGER_STOP, parameters: { projectRoot } }, () => serialize(stopPoller));

  const replace = (config: ChannelConfig): Promise<StateResult<ChannelConnectionState>> =>
    processWithLog({ operation: CHANNEL_OPERATIONS.MANAGER_REPLACE, parameters: { projectRoot } }, () => serialize(async () => {
      // Stop the current listener before a candidate runs so two pollers for
      // the same token never compete.
      await stopPoller();
      return startInternal(config);
    }));

  return { projectRoot, owner, state, start, stop, replace };
}