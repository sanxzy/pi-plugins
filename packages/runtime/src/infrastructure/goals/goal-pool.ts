import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseGoalInterval,
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

export interface GoalPool {
  readonly projectRoot: string;
  readonly store: GoalStore;
  /** Create a goal after normalizing the cwd and validating its input. */
  create(input: GoalCreateInput): GoalMutationResult;
  /** Pause the normalized cwd goal. */
  pause(cwd: string, reason: string): GoalMutationResult;
  /** Resume the normalized cwd goal. */
  resume(cwd: string): GoalMutationResult;
  /** Return a normalized cwd goal. */
  get(cwd: string): Goal | undefined;
  /** Clear the normalized cwd goal. */
  clear(cwd: string): boolean;
  /** Read every persisted goal fresh. */
  all(): Map<string, Goal>;
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

export function createGoalPool(projectRoot: string): GoalPool {
  const store = createGoalStore(goalsFile(projectRoot));
  const lockByCwd = new Set<string>();

  const withCwdMutation = <T>(cwd: string, operation: () => T): T => {
    if (lockByCwd.has(cwd)) {
      // JavaScript mutations are synchronous, so this branch only protects
      // re-entrant callers and makes the per-cwd serialization contract clear.
      throw new Error(`goal mutation already in progress for cwd: ${cwd}`);
    }
    lockByCwd.add(cwd);
    try {
      return operation();
    } finally {
      lockByCwd.delete(cwd);
    }
  };

  return {
    projectRoot,
    store,
    create(input) {
      const cwd = normalizeGoalCwd(input.cwd);
      return withCwdMutation(cwd, () => {
        const validation = input.intervalMs === undefined
          ? validateGoalInput({ prompt: input.prompt, interval: input.interval })
          : validateGoalInput({ prompt: input.prompt }) as ReturnType<typeof validateGoalInput>;
        if (!validation.ok) return validation;
        const intervalMs = input.intervalMs ?? validation.value.intervalMs;
        if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
          return { ok: false, error: "interval must be greater than zero" };
        }
        return store.create({ cwd, prompt: validation.value.prompt, intervalMs });
      });
    },
    pause(cwd, reason) {
      const normalized = normalizeGoalCwd(cwd);
      return withCwdMutation(normalized, () => {
        if (reason.trim().length === 0) return { ok: false, error: "pause reason must contain non-whitespace text" };
        return store.pause(normalized, reason);
      });
    },
    resume(cwd) {
      const normalized = normalizeGoalCwd(cwd);
      return withCwdMutation(normalized, () => store.resume(normalized));
    },
    get(cwd) {
      return store.get(normalizeGoalCwd(cwd));
    },
    clear(cwd) {
      const normalized = normalizeGoalCwd(cwd);
      return withCwdMutation(normalized, () => store.clear(normalized));
    },
    all() {
      return store.fold();
    },
  };
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
