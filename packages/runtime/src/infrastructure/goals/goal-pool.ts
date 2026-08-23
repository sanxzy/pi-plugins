import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  GOAL_DELIVERY_FOOTER,
  parseGoalInterval,
  splitGoalPromptInterval,
  validateGoalInput,
  type Goal,
} from "@xzy-ai/core";
import { GOAL_OPERATIONS, processWithLog, runWithLogContext, type SessionLogger } from "@xzy-ai/observability";
import { resolveSettingsForProject } from "../../shared/settings.ts";
import { encodeProjectId, homeGoalFile } from "../../shared/paths.ts";
import { createGoalStore, type GoalStore } from "./goal-store.ts";

export interface GoalCreateInput {
  readonly cwd: string;
  readonly prompt: string;
  readonly interval?: string;
  readonly intervalMs?: number;
}

export type GoalMutationResult =
  | { readonly ok: true; readonly goal: Goal }
  | { readonly ok: false; readonly error: string };

/** A host delivery binding for the goal's delivery cwd. */
export interface GoalDeliveryBinding {
  readonly cwd: string;
  readonly sendUserMessage: (content: string, options?: { readonly deliverAs?: "goal" }) => void;
  readonly hasUI: boolean;
  readonly notify: (message: string, type?: "info" | "warning" | "error") => void;
  /**
   * Whether this binding must deliver every goal tick through the host's
   * native steering queue, even while the host is busy or already queued.
   */
  readonly forceDelivery?: boolean;
  /**
   * Whether the host already has pending messages queued for delivery.
   * Non-forced bindings skip a tick when this is true to avoid stacking
   * another message behind still-pending ones.
   */
  readonly hasPendingMessages: () => boolean;
  /**
   * Explicit telemetry owner for the pool's independent scheduler root. Goal
   * ticks fire from setInterval callbacks with no ambient session context;
   * without this binding the records would fall back to the process-wide
   * last-created default logger, which can belong to an unrelated session.
   */
  readonly logger?: SessionLogger;
}

/** The timer seam keeps scheduler tests manually controllable. */
export interface GoalTimerHandle {
  unref?(): unknown;
  clear(): void;
}

export interface GoalPool {
  readonly projectRoot: string;
  readonly rootSessionId: string;
  readonly store: GoalStore;
  create(input: GoalCreateInput): GoalMutationResult;
  pause(reason: string): GoalMutationResult;
  resume(): GoalMutationResult;
  /** Change the delivery cadence of the current goal without replacing it. */
  updateInterval(input: { interval?: string; intervalMs?: number }): GoalMutationResult;
  get(): Goal | undefined;
  clear(): boolean;
  all(): Map<string, Goal>;
  /** Bind or replace the current host delivery handle. */
  bind(binding: GoalDeliveryBinding): void;
  /** Stop every timer and detach every host handle. */
  shutdown(): void;
  /** Pause all active delivery while a fresh session is confirmed. */
  beginSessionConfirmation(): boolean;
  /** Resume delivery after the replacement confirmation chooses Continue. */
  continueAfterReplacement(): void;
  /** Consume a prior replacement approval at the fresh session start. */
  takeReplacementContinuation(): boolean;
  /** Clear all active persisted goals after the replacement confirmation chooses Clear. */
  clearActiveGoals(): number;
  /** Pause all active persisted goals without removing them, e.g. on session exit. */
  pauseAllActive(reason: string): number;
  /** Resume timers after a fresh host binding is ready. */
  resumeDelivery(): void;
  /** Replace timer creation for deterministic unit tests. */
  setScheduler(factory: (callback: () => void, cwd: string, intervalMs: number) => GoalTimerHandle): void;
  /** Drive one persisted goal scheduler tick directly in tests. */
  tick(cwd: string): void;
}

/** Normalize an existing cwd to its absolute realpath; resolve when absent. */
export function normalizeGoalCwd(cwd: string): string {
  const absolute = resolve(cwd);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

/** Format an interval in milliseconds as a compact human duration such as 30s, 10m, 1h 30m, or 2d. */
export function formatGoalInterval(intervalMs: number): string {
  const units = [
    { label: "d", ms: 86_400_000 },
    { label: "h", ms: 3_600_000 },
    { label: "m", ms: 60_000 },
    { label: "s", ms: 1_000 },
  ] as const;
  const parts: string[] = [];
  let remainder = Math.max(0, intervalMs);
  for (const unit of units) {
    if (remainder >= unit.ms) {
      parts.push(`${Math.floor(remainder / unit.ms)}${unit.label}`);
      remainder %= unit.ms;
    }
  }
  return parts.length > 0 ? parts.join(" ") : `${intervalMs}ms`;
}

interface SchedulerRecord {
  readonly timer: GoalTimerHandle;
  readonly intervalMs: number;
  readonly generation: number;
}

export function createGoalPool(projectRoot: string, rootSessionId = "root"): GoalPool {
  const store = createGoalStore(homeGoalFile(encodeProjectId(projectRoot), rootSessionId), rootSessionId);
  const lockByCwd = new Set<string>();
  const bindings = new Map<string, GoalDeliveryBinding>();
  const schedulers = new Map<string, SchedulerRecord>();
  let currentBinding: GoalDeliveryBinding | undefined;
  let deliverySuspended = false;
  let schedulerGeneration = 0;
  let replacementContinued = false; // set by the pre-switch confirmation until the fresh host binds

  const clearAllSchedulers = (): void => {
    advanceSchedulerGeneration();
    for (const cwd of Array.from(schedulers.keys())) clearScheduler(cwd);
  };

  let schedule = (callback: () => void, cwd: string, intervalMs: number): GoalTimerHandle => {
    const timer = setInterval(callback, intervalMs);
    timer.unref();
    return { clear: () => clearInterval(timer) };
  };

  const clearScheduler = (cwd: string): void => {
    const record = schedulers.get(cwd);
    if (!record) return;
    record.timer.clear();
    schedulers.delete(cwd);
  };

  const tick = (cwd: string): void => {
    const binding = bindings.get(normalizeGoalCwd(cwd)) ?? currentBinding;
    const execute = (): void => {
      processWithLog({ operation: GOAL_OPERATIONS.TICK, parameters: { cwd } }, () => {
        if (deliverySuspended) return;
        const goal = store.fold().get(rootSessionId);
        if (!goal) {
          clearScheduler(cwd);
          return;
        }

        const target = bindings.get(goal.cwd) ?? currentBinding;
        if (!target) return;
        // Ordinary bindings defer behind pending host messages. The live root
        // goal binding opts into Pi's native steering queue so the exact goal
        // is accepted even while the agent is busy.
        if (!target.forceDelivery && target.hasPendingMessages()) return;
        try {
          if (goal.status === "active") {
            target.sendUserMessage(`${goal.prompt}\n${GOAL_DELIVERY_FOOTER}`, { deliverAs: "goal" });
            target.notify(`Goal triggered and sent to the current session — this goal will be sent every ${formatGoalInterval(goal.intervalMs)}.`, "info");
          } else if (target.hasUI) {
            target.notify(`Goal paused: ${goal.pauseReason ?? ""}`, "warning");
          }
        } catch {
          // One failed cwd delivery must not stop other project schedulers.
        }
      });
    };
    if (binding?.logger) runWithLogContext(binding.logger, execute);
    else execute();
  };

  const ensureScheduler = (cwd: string): void => {
    const existing = schedulers.get(cwd);
    if (existing) return;
    const goal = store.get();
    if (!goal) return;
    const generation = schedulerGeneration;
    const timer = schedule(() => {
      if (schedulerGeneration !== generation) return;
      tick(cwd);
    }, cwd, goal.intervalMs);
    schedulers.set(cwd, { timer, intervalMs: goal.intervalMs, generation });
  };

  const advanceSchedulerGeneration = (): void => {
    schedulerGeneration += 1;
  };

  const withCwdMutation = <T>(cwd: string, operation: () => T): T => {
    if (lockByCwd.has(cwd)) throw new Error(`goal mutation already in progress for cwd: ${cwd}`);
    lockByCwd.add(cwd);
    try {
      return operation();
    } finally {
      lockByCwd.delete(cwd);
    }
  };

  const pool: GoalPool = {
    projectRoot,
    rootSessionId,
    store,
    create(input) {
      const cwd = normalizeGoalCwd(input.cwd);
      return processWithLog({ operation: GOAL_OPERATIONS.CREATE, parameters: { cwd, prompt: input.prompt, interval: input.interval ?? input.intervalMs } }, () => {
        // A fresh creation must re-enable delivery if a prior shutdown had suspended it.
        deliverySuspended = false;
        const result = withCwdMutation(cwd, () => {
        // A request such as "2m testing goal" carries interval metadata before
        // the exact prompt. Split that leading duration into the scheduling
        // configuration so it is never persisted or delivered as prompt text.
        const split = input.intervalMs === undefined && input.interval === undefined
          ? splitGoalPromptInterval(input.prompt)
          : { prompt: input.prompt, interval: input.interval };
        const maxPromptLength = resolveSettingsForProject(projectRoot).commands.goalMaxPromptLength;
        const validation = input.intervalMs === undefined
          ? validateGoalInput(split, maxPromptLength)
          : validateGoalInput({ prompt: split.prompt }, maxPromptLength);
        if (!validation.ok) return validation;
        const intervalMs = input.intervalMs ?? validation.value.intervalMs;
        if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
          return { ok: false, error: "interval must be greater than zero" } as const;
        }
        return store.create({ cwd, prompt: validation.value.prompt, intervalMs });
      });
        if (result.ok) {
          ensureScheduler(cwd);
          // Fire an immediate tick so the goal prompt is delivered right away,
          // not after the full interval elapses. The tick itself skips
          // delivery when delivery is suspended or when the host binding has
          // pending messages already queued.
          tick(cwd);
        }
        return result;
      });
    },
    pause(reason) {
      return processWithLog({ operation: GOAL_OPERATIONS.PAUSE, parameters: { rootSessionId } }, () => withCwdMutation(rootSessionId, () => {
        if (reason.trim().length === 0) {
          return { ok: false, error: "pause reason must contain non-whitespace text" } as const;
        }
        return store.pause(reason);
      }));
    },
    resume() {
      const result = processWithLog({ operation: GOAL_OPERATIONS.RESUME, parameters: { rootSessionId } }, () => withCwdMutation(rootSessionId, () => store.resume()));
      if (result.ok) {
        // Resuming must clear any prior shutdown suspension so ticks can deliver.
        deliverySuspended = false;
        const goal = store.get();
        if (goal) {
          // Re-create the scheduler if it was cleared by pauseAllActive, otherwise
          // the existing interval (created while paused) continues.
          ensureScheduler(goal.cwd);
          // Fire an immediate tick so the goal prompt is delivered right away
          // after resuming, not after the full interval elapses. The tick
          // itself skips delivery when delivery is suspended or when the host
          // binding has pending messages already queued.
          tick(goal.cwd);
        }
      }
      return result;
    },
    updateInterval(input) {
      const result = processWithLog({ operation: GOAL_OPERATIONS.UPDATE_INTERVAL, parameters: { rootSessionId } }, () => withCwdMutation(rootSessionId, () => {
        let intervalMs = input.intervalMs;
        if (intervalMs === undefined) {
          const parsed = parseGoalInterval(input.interval);
          if (!parsed.ok) return parsed as GoalMutationResult;
          intervalMs = parsed.value;
        }
        if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
          return { ok: false as const, error: "interval must be greater than zero" };
        }
        return store.updateInterval(intervalMs);
      }));
      if (result.ok) {
        // Re-arm the scheduler on the new cadence without firing an immediate
        // tick: changing the interval must not itself trigger a delivery.
        const goal = store.get();
        if (goal) {
          clearScheduler(goal.cwd);
          ensureScheduler(goal.cwd);
        }
      }
      return result;
    },
    get() {
      return store.get();
    },
    clear() {
      const goal = store.get();
      const cleared = processWithLog({ operation: GOAL_OPERATIONS.CLEAR, parameters: { rootSessionId } }, () => withCwdMutation(rootSessionId, () => store.clear()));
      if (cleared && goal) clearScheduler(goal.cwd);
      return cleared;
    },
    all() {
      return store.fold();
    },
    bind(binding) {
      const normalized = { ...binding, cwd: normalizeGoalCwd(binding.cwd) };
      bindings.set(normalized.cwd, normalized);
      currentBinding = normalized;
      processWithLog({ operation: GOAL_OPERATIONS.BIND, parameters: { cwd: normalized.cwd } }, () => {
        if (!deliverySuspended) {
          const goal = store.get();
          if (goal) ensureScheduler(goal.cwd);
        }
      });
    },
    shutdown() {
      processWithLog({ operation: GOAL_OPERATIONS.SHUTDOWN }, () => {
        clearAllSchedulers();
        bindings.clear();
        currentBinding = undefined;
        deliverySuspended = true;
      });
    },
    beginSessionConfirmation() {
      const goal = store.get();
      if (!goal || goal.status !== "active") return false;
      deliverySuspended = true;
      // Stop every cwd timer while the host replacement is unresolved. This
      // also suppresses paused-goal warnings until the decision completes.
      clearAllSchedulers();
      return true;
    },
    continueAfterReplacement() {
      replacementContinued = true;
    },
    takeReplacementContinuation() {
      const continued = replacementContinued;
      replacementContinued = false;
      return continued;
    },
    clearActiveGoals() {
      const goal = store.get();
      if (!goal || goal.status !== "active") return 0;
      processWithLog({ operation: GOAL_OPERATIONS.CLEAR_ACTIVE, parameters: { count: 1 } }, () => {
        clearScheduler(goal.cwd);
        store.clear();
        deliverySuspended = true;
      });
      return 1;
    },
    pauseAllActive(reason) {
      const goal = store.get();
      if (!goal || goal.status !== "active") return 0;
      processWithLog({ operation: GOAL_OPERATIONS.PAUSE_ALL, parameters: { count: 1, reason } }, () => {
        clearScheduler(goal.cwd);
        store.pause(reason);
        deliverySuspended = true;
      });
      return 1;
    },
    setScheduler(factory) {
      schedule = factory;
    },
    tick,
    resumeDelivery() {
      deliverySuspended = false;
      processWithLog({ operation: GOAL_OPERATIONS.RESUME_DELIVERY }, () => {
        const goal = store.get();
        if (goal) ensureScheduler(goal.cwd);
      });
    },
  };

  return pool;
}

declare global {
  // eslint-disable-next-line no-var
  var piC2GoalPools: Record<string, GoalPool> | undefined;
}

const GOAL_POOL_SLOT_PREFIX = "pi-c2-goals:";

export function getGoalPool(projectRoot: string, rootSessionId = "root"): GoalPool {
  const slot = `${GOAL_POOL_SLOT_PREFIX}${projectRoot}:${rootSessionId}`;
  const existing = globalThis.piC2GoalPools?.[slot];
  if (existing) return existing;
  const pool = createGoalPool(projectRoot, rootSessionId);
  globalThis.piC2GoalPools ??= {};
  globalThis.piC2GoalPools[slot] = pool;
  return pool;
}
