import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  GOAL_DELIVERY_FOOTER,
  splitGoalPromptInterval,
  validateGoalInput,
  type Goal,
} from "@xzy-ai/core";
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

/** A host delivery binding for one cwd's goal scheduler. */
export interface GoalDeliveryBinding {
  readonly cwd: string;
  readonly sendUserMessage: (content: string, options?: { readonly deliverAs?: "steer" }) => void;
  readonly hasUI: boolean;
  readonly notify: (message: string, type?: "info" | "warning" | "error") => void;
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
  pause(cwd: string, reason: string): GoalMutationResult;
  resume(cwd: string): GoalMutationResult;
  get(cwd: string): Goal | undefined;
  clear(cwd: string): boolean;
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

interface SchedulerRecord {
  readonly timer: GoalTimerHandle;
  readonly intervalMs: number;
  readonly generation: number;
}

export function createGoalPool(projectRoot: string, rootSessionId = "root"): GoalPool {
  const store = createGoalStore(homeGoalFile(encodeProjectId(projectRoot), rootSessionId));
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
    if (deliverySuspended) return;
    const normalizedCwd = normalizeGoalCwd(cwd);
    const goals = store.fold();
    const goal = goals.get(normalizedCwd);
    if (!goal) {
      clearScheduler(cwd);
      return;
    }

    const binding = bindings.get(goal.cwd) ?? currentBinding;
    if (!binding) return;

    try {
      if (goal.status === "active") {
        binding.sendUserMessage(`${goal.prompt}\n${GOAL_DELIVERY_FOOTER}`, { deliverAs: "steer" });
      } else if (binding.hasUI) {
        binding.notify(`Goal paused: ${goal.pauseReason ?? ""}`, "warning");
      }
    } catch {
      // One failed cwd delivery must not stop other project schedulers.
    }
  };

  const ensureScheduler = (cwd: string): void => {
    const existing = schedulers.get(cwd);
    if (existing) return;
    const goal = store.get(cwd);
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
      const result = withCwdMutation(cwd, () => {
        // A request such as "2m testing goal" carries interval metadata before
        // the exact prompt. Split that leading duration into the scheduling
        // configuration so it is never persisted or delivered as prompt text.
        const split = input.intervalMs === undefined && input.interval === undefined
          ? splitGoalPromptInterval(input.prompt)
          : { prompt: input.prompt, interval: input.interval };
        const validation = input.intervalMs === undefined
          ? validateGoalInput(split)
          : validateGoalInput({ prompt: split.prompt });
        if (!validation.ok) return validation;
        const intervalMs = input.intervalMs ?? validation.value.intervalMs;
        if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
          return { ok: false, error: "interval must be greater than zero" } as const;
        }
        return store.create({ cwd, prompt: validation.value.prompt, intervalMs });
      });
      if (result.ok) ensureScheduler(cwd);
      return result;
    },
    pause(cwd, reason) {
      const normalized = normalizeGoalCwd(cwd);
      return withCwdMutation(normalized, () => {
        if (reason.trim().length === 0) {
          return { ok: false, error: "pause reason must contain non-whitespace text" } as const;
        }
        return store.pause(normalized, reason);
      });
    },
    resume(cwd) {
      const normalized = normalizeGoalCwd(cwd);
      const result = withCwdMutation(normalized, () => store.resume(normalized));
      if (result.ok) ensureScheduler(normalized);
      return result;
    },
    get(cwd) {
      return store.get(normalizeGoalCwd(cwd));
    },
    clear(cwd) {
      const normalized = normalizeGoalCwd(cwd);
      const cleared = withCwdMutation(normalized, () => store.clear(normalized));
      if (cleared) clearScheduler(normalized);
      return cleared;
    },
    all() {
      return store.fold();
    },
    bind(binding) {
      const normalized = { ...binding, cwd: normalizeGoalCwd(binding.cwd) };
      bindings.set(normalized.cwd, normalized);
      currentBinding = normalized;
      if (!deliverySuspended) {
        for (const cwd of store.fold().keys()) ensureScheduler(cwd);
      }
    },
    shutdown() {
      clearAllSchedulers();
      bindings.clear();
      currentBinding = undefined;
      deliverySuspended = true;
    },
    beginSessionConfirmation() {
      const activeGoals = Array.from(store.fold().values()).filter((goal) => goal.status === "active");
      if (activeGoals.length === 0) return false;
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
      const activeGoals = Array.from(store.fold().values()).filter((goal) => goal.status === "active");
      for (const goal of activeGoals) {
        clearScheduler(goal.cwd);
        store.clear(goal.cwd);
      }
      deliverySuspended = true;
      return activeGoals.length;
    },
    setScheduler(factory) {
      schedule = factory;
    },
    tick,
    resumeDelivery() {
      deliverySuspended = false;
      for (const cwd of store.fold().keys()) ensureScheduler(cwd);
    },
  };

  return pool;
}

declare global {
  // eslint-disable-next-line no-var
  var piCodeGoalPools: Record<string, GoalPool> | undefined;
}

const GOAL_POOL_SLOT_PREFIX = "pi-code-goals:";

export function getGoalPool(projectRoot: string, rootSessionId = "root"): GoalPool {
  const slot = `${GOAL_POOL_SLOT_PREFIX}${projectRoot}:${rootSessionId}`;
  const existing = globalThis.piCodeGoalPools?.[slot];
  if (existing) return existing;
  const pool = createGoalPool(projectRoot, rootSessionId);
  globalThis.piCodeGoalPools ??= {};
  globalThis.piCodeGoalPools[slot] = pool;
  return pool;
}