import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { loadChannelConfig, saveChannelStatus, isValidChannelConfig, type ChannelConfig } from "../state/index.ts";
import {
  loadChannelStatus,
  type ChannelLifecycleState,
  type ChannelStatusSnapshot,
} from "../state/status.ts";
import type { TelegramCommandInfo } from "./index.ts";

export interface TelegramPollerCallbacks {
  /** Called once for every completed successful getUpdates cycle. */
  onCycle(updates: readonly unknown[]): Promise<void> | void;
  /** Called for polling/API failures before the poller exits or retries. */
  onError(error: unknown): void;
}

/**
 * The only polling surface exposed to the manager. Implementations own the
 * actual Bot/grammY client; callers cannot acquire a raw polling bot.
 */
export interface TelegramPoller {
  /** Validate token/API access without starting long polling. */
  validate(): Promise<void>;
  /** Start the long-lived task; resolves only when it exits. */
  start(): Promise<void>;
  /** Stop polling and wait until the task has released its transport. */
  stop(): Promise<void>;
}

export interface TelegramChannelStatus extends ChannelStatusSnapshot {
  generation: number;
  canonicalCwd: string;
}

export interface TelegramChannelManagerOptions {
  createPoller?: (config: ChannelConfig, callbacks: TelegramPollerCallbacks) => TelegramPoller;
  now?: () => string;
  /** Optional safe warning sink for startup/polling failures. */
  warn?: (message: string) => void;
}

export interface TelegramChannelManager {
  start(commands: readonly TelegramCommandInfo[]): Promise<void>;
  reload(commands: readonly TelegramCommandInfo[]): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
  status(): TelegramChannelStatus;
}

const managers = new Map<string, TelegramChannelManager>();

function canonicalize(projectRoot: string): string {
  try {
    return realpathSync(projectRoot);
  } catch {
    // A project may not exist yet during tests/startup; use the absolute path
    // fallback while preserving the one-manager-per-cwd contract.
    return resolve(projectRoot);
  }
}

function safeDescription(error: unknown): { message: string; nextStep: string } {
  const code = typeof error === "object" && error !== null && "error_code" in error
    ? Number((error as { error_code?: unknown }).error_code)
    : undefined;
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "Telegram transport failed";
  const normalized = text.toLowerCase();
  if (code === 401 || normalized.includes("unauthorized") || normalized.includes("invalid token")) {
    return { message: "Telegram authentication failed", nextStep: "Run /setup-channel-telegram and replace the bot token." };
  }
  if (code === 409 || normalized.includes("conflict")) {
    return { message: "Telegram polling conflict", nextStep: "Stop the other Telegram poller, then restart the channel." };
  }
  if (code === 429 || normalized.includes("rate limit") || normalized.includes("too many requests")) {
    return { message: "Telegram rate limit; retrying", nextStep: "Wait for Telegram's retry window; the channel will retry automatically." };
  }
  if (normalized.includes("webhook")) {
    return { message: "Telegram webhook cleanup failed", nextStep: "Remove the Telegram webhook, then restart the channel." };
  }
  return { message: "Telegram transport temporarily unavailable", nextStep: "Check network access, then wait for the channel to recover." };
}

function initialStatus(canonicalCwd: string): TelegramChannelStatus {
  return {
    state: "stopped",
    generation: 0,
    canonicalCwd,
    updatedAt: new Date(0).toISOString(),
  };
}

export function acquireTelegramChannelManager(
  projectRoot: string,
  options: TelegramChannelManagerOptions = {},
): TelegramChannelManager {
  const canonicalCwd = canonicalize(projectRoot);
  const existing = managers.get(canonicalCwd);
  if (existing !== undefined) return existing;

  const now = options.now ?? (() => new Date().toISOString());
  const warn = options.warn ?? ((message) => console.warn(message));
  const createPoller = options.createPoller ?? createDefaultPoller;
  let snapshot: TelegramChannelStatus = {
    ...(loadChannelStatus(canonicalCwd) ?? initialStatus(canonicalCwd)),
    canonicalCwd,
    generation: 0,
  };
  let generation = snapshot.generation;
  let poller: TelegramPoller | undefined;
  let startOperation: Promise<void> = Promise.resolve();
  let disposed = false;
  const readinessTimeoutMs = 30_000;

  const publish = (state: ChannelLifecycleState, details?: { message?: string; nextStep?: string }): void => {
    snapshot = {
      state,
      generation,
      canonicalCwd,
      updatedAt: now(),
      lastError: details?.message,
      nextStep: details?.nextStep,
    };
    saveChannelStatus(canonicalCwd, snapshot);
  };

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = startOperation.then(operation, operation);
    startOperation = next.then(() => undefined, () => undefined);
    return next;
  };

  async function doStart(commands: readonly TelegramCommandInfo[]): Promise<void> {
    if (disposed) return;
    if (poller !== undefined) return;
    const config = loadChannelConfig(canonicalCwd);
    if (config === null || !isValidChannelConfig(config)) {
      generation += 1;
      publish("unconfigured");
      return;
    }
    const currentGeneration = ++generation;
    let ready = false;
    let taskSettled = false;
    let taskError: unknown;
    publish("starting");
    const created = createPoller(config, {
      onCycle: async (_updates) => {
        if (currentGeneration !== generation || poller !== created) return;
        if (!ready) ready = true;
        if (snapshot.state === "starting" || snapshot.state === "recovering") publish("connected");
      },
      onError: (error) => {
        if (currentGeneration !== generation || poller !== created) return;
        const safe = safeDescription(error);
        const recoverable = safe.message === "Telegram transport temporarily unavailable" || safe.message === "Telegram rate limit; retrying";
        publish(recoverable ? "recovering" : "blocked", safe);
        if (!recoverable) warn(safe.message);
      },
    });
    poller = created;
    try {
      await created.validate();
      if (currentGeneration !== generation || poller !== created) return;
      const task = created.start();
      // Start must not await the long-lived polling promise before readiness.
      // The poller emits onCycle after each completed getUpdates request.
      void task.then(
        () => {
          taskSettled = true;
          // A clean poller stop before readiness is a failure, but never clobber
          // an already-classified blocked state (e.g. an ownership conflict that
          // onError already reported) with the generic message.
          if (currentGeneration !== generation || poller !== created || ready || snapshot.state === "blocked") return;
          const error = taskError ?? new Error("Telegram polling stopped before readiness");
          const safe = safeDescription(error);
          publish("blocked", safe);
          warn(safe.message);
        },
        (error: unknown) => {
          taskSettled = true;
          taskError = error;
          if (currentGeneration !== generation || poller !== created) return;
          const safe = safeDescription(error);
          publish("blocked", safe);
          warn(safe.message);
        },
      );
      await waitForReadiness(
        currentGeneration,
        () => ({ state: snapshot.state, ready, taskSettled }),
        () => poller === created,
        () => snapshot.lastError ?? "Telegram polling failed",
        readinessTimeoutMs,
      );
      if (snapshot.state === "blocked") {
        throw new Error(snapshot.lastError ?? "Telegram polling failed");
      }
      void commands;
    } catch (error) {
      if (currentGeneration === generation && poller === created) {
        const safe = safeDescription(error);
        if (snapshot.state !== "blocked") publish("blocked", safe);
        // Failed validation/readiness must release the transport before the
        // manager can be replaced or acquired again.
        await created.stop().catch(() => undefined);
        poller = undefined;
      }
      const safe = safeDescription(error);
      throw new Error(safe.message);
    }
  }

  async function doStop(): Promise<void> {
    generation += 1;
    const current = poller;
    poller = undefined;
    if (current !== undefined) await current.stop();
    publish("stopped");
  }

  const manager: TelegramChannelManager = {
    start(commands): Promise<void> {
      return enqueue(() => doStart(commands));
    },

    reload(commands): Promise<void> {
      return enqueue(async () => {
        await doStop();
        await doStart(commands);
      });
    },

    stop(): Promise<void> {
      return enqueue(doStop);
    },

    dispose(): Promise<void> {
      return enqueue(async () => {
        disposed = true;
        await doStop();
        managers.delete(canonicalCwd);
      });
    },

    status(): TelegramChannelStatus {
      return { ...snapshot };
    },
  };

  managers.set(canonicalCwd, manager);
  return manager;
}

function waitForReadiness(
  expectedGeneration: number,
  getState: () => { state: ChannelLifecycleState; ready: boolean; taskSettled: boolean },
  isCurrent: () => boolean,
  lastError: () => string,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + timeoutMs;
    const finish = (operation: () => void): void => {
      if (timer !== undefined) clearTimeout(timer);
      operation();
    };
    const check = (): void => {
      if (!isCurrent() || expectedGeneration <= 0) {
        finish(() => reject(new Error("Telegram lifecycle was replaced before readiness")));
        return;
      }
      const current = getState();
      if (current.state === "connected" && current.ready) {
        finish(resolvePromise);
        return;
      }
      if (current.state === "blocked") {
        finish(() => reject(new Error(lastError())));
        return;
      }
      if (current.taskSettled && !current.ready) {
        finish(() => reject(new Error(lastError())));
        return;
      }
      if (Date.now() >= deadline) {
        finish(() => reject(new Error("Telegram readiness timed out")));
        return;
      }
      // The poller owns the actual wait. This timer is only a wake-up seam and
      // is unref'd so a failed startup cannot keep Pi alive indefinitely.
      timer = setTimeout(check, Math.min(10, Math.max(1, deadline - Date.now())));
      timer.unref?.();
    };
    check();
  });
}

/**
 * Real grammY-backed poller. It validates via getMe, deletes any stale webhook,
 * then drives the long-polling loop itself so the manager can observe the first
 * successful getUpdates cycle as readiness. The bot token is never logged and
 * never leaves this boundary.
 */
async function createRealPoller(config: ChannelConfig, callbacks: TelegramPollerCallbacks): Promise<TelegramPoller> {
  const { createBot } = await import("../outbound/bot.ts");
  const bot = createBot(config.botToken);
  let stopping = false;
  let run: Promise<void> | undefined;
  let lastTried = 0;
  const pollingAbortController = new AbortController();

  const safeSleep = (ms: number): Promise<void> =>
    new Promise((resolveSleep) => {
      const timer = setTimeout(resolveSleep, ms);
      timer.unref?.();
    });

  const runLoop = async (): Promise<void> => {
    // Clear any webhook so getUpdates long polling owns the token. Cleanup is a
    // startup boundary: report it and fail closed rather than retrying forever.
    try {
      await bot.api.deleteWebhook?.({ drop_pending_updates: false });
    } catch (error) {
      callbacks.onError(error);
      throw error;
    }
    while (!stopping) {
      try {
        const updates = await bot.api.getUpdates?.(
          { offset: lastTried + 1, timeout: 30 },
          pollingAbortController.signal as unknown as Parameters<typeof bot.api.getUpdates>[1],
        );
        if (updates === undefined) break;
        for (const update of updates as readonly { update_id?: number }[]) {
          await bot.handleUpdate(update as unknown as Parameters<typeof bot.handleUpdate>[0]);
          if (typeof update?.update_id === "number") lastTried = Math.max(lastTried, update.update_id);
        }
        await callbacks.onCycle(updates);
      } catch (error) {
        callbacks.onError(error);
        // Fatal errors (auth/conflict) reject; transient errors back off so the
        // manager can report recovering and retry.
        const code = typeof error === "object" && error !== null && "error_code" in error
          ? Number((error as { error_code?: unknown }).error_code)
          : undefined;
        if (code === 401 || code === 409) throw error;
        await safeSleep(code === 429 ? 3000 : 1000);
      }
    }
  };

  return {
    async validate(): Promise<void> {
      // init() performs getMe and installs botInfo, which is required before
      // bot.handleUpdate can construct grammY contexts.
      await bot.init();
    },
    async start(): Promise<void> {
      if (run !== undefined) return run;
      run = runLoop();
      return run;
    },
    async stop(): Promise<void> {
      if (stopping) return;
      stopping = true;
      pollingAbortController.abort();
      // Confirm the last received update so it is not reprocessed on restart.
      try {
        await bot.api.getUpdates?.({ offset: lastTried + 1, limit: 1 });
      } catch {
        // Best-effort confirmation; the poller may already be gone.
      }
      try {
        await run;
      } catch {
        // A stopped poller may have exited with a transport error; ignore it.
      }
    },
  };
}

/** Lazy factory matching the synchronous TelegramPoller interface. */
function createDefaultPoller(config: ChannelConfig, callbacks: TelegramPollerCallbacks): TelegramPoller {
  let resolved: TelegramPoller | undefined;
  let resolving: Promise<TelegramPoller> | undefined;
  const resolve = async (): Promise<TelegramPoller> => {
    resolving ??= createRealPoller(config, callbacks);
    resolved ??= await resolving;
    return resolved;
  };
  return {
    validate: async () => (await resolve()).validate(),
    start: async () => (await resolve()).start(),
    stop: async () => (await resolve()).stop(),
  };
}

export async function resetTelegramChannelManagers(): Promise<void> {
  const current = [...managers.values()];
  await Promise.all(current.map((manager) => manager.dispose()));
  managers.clear();
}

export { channelStatusPath, loadChannelStatus } from "../state/status.ts";
