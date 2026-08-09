import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  GOAL_DELIVERY_FOOTER,
  validateGoalInput,
  type Goal,
} from "@xzy-ai/core";
import { goalsFile } from "../../shared/paths.ts";
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
  readonly sendUserMessage: (content: string, options?: { readonly deliverAs?: "steer" | "followUp" }) => void;
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
}

export function createGoalPool(projectRoot: string): GoalPool {
  const store = createGoalStore(goalsFile(projectRoot));
  const lockByCwd = new Set<string>();
  const bindings = new Map<string, GoalDeliveryBinding>();
  const schedulers = new Map<string, SchedulerRecord>();
  let currentBinding: GoalDeliveryBinding | undefined;

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
    const goals = store.fold();
    const goal = goals.get(cwd);
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
    if (schedulers.has(cwd)) return;
    const goal = store.get(cwd);
    if (!goal) return;
    const timer = schedule(() => tick(cwd), cwd, goal.intervalMs);
    schedulers.set(cwd, { timer, intervalMs: goal.intervalMs });
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
    store,
    create(input) {
      const cwd = normalizeGoalCwd(input.cwd);
      const result = withCwdMutation(cwd, () => {
        const validation = input.intervalMs === undefined
          ? validateGoalInput({ prompt: input.prompt, interval: input.interval })
          : validateGoalInput({ prompt: input.prompt });
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
      for (const cwd of store.fold().keys()) ensureScheduler(cwd);
    },
    shutdown() {
      for (const cwd of Array.from(schedulers.keys())) clearScheduler(cwd);
      bindings.clear();
      currentBinding = undefined;
    },
    setScheduler(factory) {
      schedule = factory;
    },
    tick,
  };

  return pool;
}

declare global {
  // eslint-disable-next-line no-var
  var piCodeGoalPools: Record<string, GoalPool> | undefined;
}

const GOAL_POOL_SLOT_PREFIX = "pi-code-goals:";

export function getGoalPool(projectRoot: string): GoalPool {
  const slot = `${GOAL_POOL_SLOT_PREFIX}${projectRoot}`;
  const existing = globalThis.piCodeGoalPools?.[slot];
  if (existing) return existing;
  const pool = createGoalPool(projectRoot);
  globalThis.piCodeGoalPools ??= {};
  globalThis.piCodeGoalPools[slot] = pool;
  return pool;
}