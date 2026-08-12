import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Goal } from "@xzy-ai/core";
import { TOOL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { getChildPool, getGoalPool } from "@xzy-ai/runtime";
import {
  goalCreateParams,
  goalNoArgsParams,
  goalPauseParams,
  type GoalCreateParams,
  type GoalPauseParams,
} from "../tools.ts";
import { errorResult, textResult } from "../results.ts";

interface GoalToolDetails {
  readonly goal?: Goal;
  readonly reason?: string;
}

type GoalToolResult = AgentToolResult<GoalToolDetails>;

function isMainHost(ctx: ExtensionContext): boolean {
  const pool = getChildPool(ctx.cwd, ctx.sessionManager.getSessionId());
  // Tool authorization is an ordinary call-site boundary, not lifecycle
  // bootstrap. Only a persisted active session manifest may authorize goals;
  // unknown/unpersisted ids must remain unavailable.
  return pool.isRootSession(ctx.sessionManager.getSessionId());
}

function unavailableToChild(): GoalToolResult {
  return errorResult("goal tools are unavailable in child sessions", {
    reason: "child session",
  });
}

function goalOrError(ctx: ExtensionContext): { pool: ReturnType<typeof getGoalPool>; cwd: string } | GoalToolResult {
  if (!isMainHost(ctx)) return unavailableToChild();
  return { pool: getGoalPool(ctx.cwd, ctx.sessionManager.getSessionId()), cwd: ctx.cwd };
}

function formatGoal(goal: Goal): string {
  const pause = goal.status === "paused" ? `\nPause reason: ${goal.pauseReason ?? ""}` : "";
  return [
    `Goal status: ${goal.status}`,
    `Prompt: ${goal.prompt}`,
    `Interval: ${goal.intervalMs}ms`,
    `Goal id: ${goal.goalId}`,
    `Cwd: ${goal.cwd}`,
    `Updated: ${goal.updatedAt}`,
    pause,
  ].filter(Boolean).join("\n");
}

function success<T extends GoalToolDetails>(text: string, details: T): AgentToolResult<T> {
  return textResult(text, details);
}

export function registerGoalTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "goal_create",
    label: "Create goal",
    description: "Create one persistent cwd-scoped goal. Preserve the prompt exactly; clear an existing goal before creating a replacement.",
    promptSnippet: "Create a persistent goal for the current working directory.",
    parameters: goalCreateParams,
    async execute(_toolCallId: string, params: GoalCreateParams, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<GoalToolResult> {
      return processWithLog({ operation: TOOL_OPERATIONS.GOALS_EXECUTE, parameters: { action: "create" } }, async () => {
      const target = goalOrError(ctx);
      if ("content" in target) return target;
      const result = target.pool.create({ cwd: target.cwd, prompt: params.prompt, interval: params.interval });
      if (!result.ok) return errorResult(result.error, { reason: result.error });
      return success(`Goal created: ${result.goal.prompt}\n${formatGoal(result.goal)}`, { goal: result.goal });
      });
    },
  });

  pi.registerTool({
    name: "goal_pause",
    label: "Pause goal",
    description: "Pause the current goal with an exact non-empty reason.",
    parameters: goalPauseParams,
    async execute(_toolCallId: string, params: GoalPauseParams, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<GoalToolResult> {
      return processWithLog({ operation: TOOL_OPERATIONS.GOALS_EXECUTE, parameters: { action: "pause" } }, async () => {
      const target = goalOrError(ctx);
      if ("content" in target) return target;
      const result = target.pool.pause(target.cwd, params.reason);
      if (!result.ok) return errorResult(result.error, { reason: result.error });
      return success(`Goal paused: ${params.reason}`, { goal: result.goal });
      });
    },
  });

  pi.registerTool({
    name: "goal_resume",
    label: "Resume goal",
    description: "Resume the current paused goal and restore active delivery.",
    parameters: goalNoArgsParams,
    async execute(_toolCallId: string, _params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<GoalToolResult> {
      return processWithLog({ operation: TOOL_OPERATIONS.GOALS_EXECUTE, parameters: { action: "resume" } }, async () => {
      const target = goalOrError(ctx);
      if ("content" in target) return target;
      const result = target.pool.resume(target.cwd);
      if (!result.ok) return errorResult(result.error, { reason: result.error });
      return success(`Goal resumed: ${result.goal.status}`, { goal: result.goal });
      });
    },
  });

  pi.registerTool({
    name: "goal_status",
    label: "Goal status",
    description: "Show the complete current goal record for this working directory.",
    parameters: goalNoArgsParams,
    async execute(_toolCallId: string, _params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<GoalToolResult> {
      return processWithLog({ operation: TOOL_OPERATIONS.GOALS_EXECUTE, parameters: { action: "status" } }, async () => {
      const target = goalOrError(ctx);
      if ("content" in target) return target;
      const goal = target.pool.get(target.cwd);
      if (!goal) return errorResult("no goal exists for this cwd", { reason: "no goal exists for this cwd" });
      return success(formatGoal(goal), { goal });
      });
    },
  });

  pi.registerTool({
    name: "goal_clear",
    label: "Clear goal",
    description: "Clear my current goal when I decide it is complete.",
    parameters: goalNoArgsParams,
    async execute(_toolCallId: string, _params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<GoalToolResult> {
      return processWithLog({ operation: TOOL_OPERATIONS.GOALS_EXECUTE, parameters: { action: "clear" } }, async () => {
      const target = goalOrError(ctx);
      if ("content" in target) return target;
      const goal = target.pool.get(target.cwd);
      if (!goal) return errorResult("no goal exists to clear for this cwd", { reason: "no goal exists to clear for this cwd" });
      if (!target.pool.clear(target.cwd)) return errorResult("no goal exists to clear for this cwd", { reason: "no goal exists to clear for this cwd" });
      return success("Congratulations, the goal was completed and cleared.", { goal });
      });
    },
  });
}
