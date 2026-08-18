import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getChildPool, getGoalPool, type GoalPool } from "@xzy-ai/runtime";
import type {
  ManageGoalApplyResult,
  ManageGoalController,
  ManageGoalItem,
} from "@xzy-ai/tui";

/**
 * UI-agnostic boundary implemented by the commands package and driven by the
 * TUI wizard. Mutations go through the session's goal pool so the persisted
 * goal and its scheduler stay consistent with the goal tools.
 */
export interface ManageGoalControllerOptions {
  cwd: string;
  sessionId: string;
  /** Override the pool for deterministic tests. */
  pool?: GoalPool;
}

/** True only for a host root session, never for a registered child job. */
function isRootSession(cwd: string, sessionId: string): boolean {
  const pool = getChildPool(cwd, sessionId);
  return pool.isRootSession(sessionId) || pool.shouldBootstrapRootSession(sessionId);
}

function goalToItem(goal: NonNullable<ReturnType<GoalPool["get"]>>): ManageGoalItem {
  return {
    goalId: goal.goalId,
    rootSessionId: goal.rootSessionId,
    cwd: goal.cwd,
    prompt: goal.prompt,
    intervalMs: goal.intervalMs,
    status: goal.status,
    pauseReason: goal.pauseReason,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

/** Create the controller for `/manage-goal`. */
export function createManageGoalController(options: ManageGoalControllerOptions): ManageGoalController {
  const { cwd, sessionId } = options;
  const pool = options.pool ?? getGoalPool(cwd, sessionId);

  const unavailable = (): ManageGoalApplyResult => ({ ok: false, message: "goal management is unavailable in child sessions" });

  return {
    async get() {
      if (!isRootSession(cwd, sessionId)) return undefined;
      const goal = pool.get();
      return goal ? goalToItem(goal) : undefined;
    },
    async create({ prompt, interval, signal: _signal }) {
      if (!isRootSession(cwd, sessionId)) return unavailable();
      // Replace semantics: a request to create when one exists clears the old
      // goal first, matching the goal tools' "clear an existing goal before
      // creating a replacement" contract.
      const current = pool.get();
      if (current) {
        const cleared = pool.clear();
        if (!cleared) return { ok: false, message: "a goal already exists for this session; clear it first" };
      }
      const result = pool.create({ cwd, prompt, interval: interval || undefined });
      if (!result.ok) return { ok: false, message: result.error };
      return { ok: true, message: "Goal created." };
    },
    async pause(reason, _signal) {
      if (!isRootSession(cwd, sessionId)) return unavailable();
      const result = pool.pause(reason);
      return result.ok ? { ok: true, message: "Goal paused." } : { ok: false, message: result.error };
    },
    async resume(_signal) {
      if (!isRootSession(cwd, sessionId)) return unavailable();
      const result = pool.resume();
      return result.ok ? { ok: true, message: "Goal resumed." } : { ok: false, message: result.error };
    },
    async clear(_signal) {
      if (!isRootSession(cwd, sessionId)) return unavailable();
      const cleared = pool.clear();
      return cleared ? { ok: true, message: "Goal cleared." } : { ok: false, message: "no goal exists to clear for this session" };
    },
    async cancel() {
      await undefined;
    },
  };
}
