import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Goal } from "@xzy-ai/core";
import { TOOL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { getChildPool, getGoalPool } from "@xzy-ai/runtime";
import {
  goalCreateParams,
  goalClearParams,
  goalNoArgsParams,
  goalPauseParams,
  type GoalClearParams,
  type GoalCreateParams,
  type GoalPauseParams,
} from "../tools.ts";
import { errorResult, textResult } from "../results.ts";
import { renderToolCall, renderToolOutcome, toolResultFailed } from "../render.ts";

interface GoalToolDetails {
  readonly goal?: Goal;
  readonly reason?: string;
  readonly sessionId?: string;
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

function goalOrError(ctx: ExtensionContext): { pool: ReturnType<typeof getGoalPool>; cwd: string; sessionId: string } | GoalToolResult {
  if (!isMainHost(ctx)) return unavailableToChild();
  const sessionId = ctx.sessionManager.getSessionId();
  return { pool: getGoalPool(ctx.cwd, sessionId), cwd: ctx.cwd, sessionId };
}

function formatGoal(goal: Goal): string {
  const pause = goal.status === "paused" ? `\nPause reason: ${goal.pauseReason ?? ""}` : "";
  return [
    `Goal status: ${goal.status}`,
    `Prompt: ${goal.prompt}`,
    `Interval: ${goal.intervalMs}ms`,
    `Goal id: ${goal.goalId}`,
    `Root session: ${goal.rootSessionId}`,
    `Cwd: ${goal.cwd}`,
    `Updated: ${goal.updatedAt}`,
    pause,
  ].filter(Boolean).join("\n");
}

function notCompleteAdvice(goal: Goal): string {
  return [
    "Goal not cleared. The goal is not yet complete and should be finished before it can be cleared.",
    `Current goal context: ${goal.prompt}`,
  ].join("\n");
}

function success<T extends GoalToolDetails>(text: string, details: T): AgentToolResult<T> {
  return textResult(text, details);
}

export function registerGoalTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "goal_create",
    label: "Create goal",
    description: "Create one persistent session-scoped goal. Preserve the prompt exactly; clear an existing goal before creating a replacement. Goals belong to the root session, not the working directory.",
    promptSnippet: "Create a persistent goal for the current session.",
    parameters: goalCreateParams,
    async execute(_toolCallId: string, params: GoalCreateParams, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<GoalToolResult> {
      return processWithLog({ operation: TOOL_OPERATIONS.GOALS_EXECUTE, parameters: { action: "create" } }, async () => {
      const target = goalOrError(ctx);
      if ("content" in target) return target;
      const result = target.pool.create({ cwd: target.cwd, prompt: params.prompt, interval: params.interval });
      if (!result.ok) return errorResult(result.error, { reason: result.error });
      return success(`Goal created successfully! Please proceed carefully and complete the work correctly.\n${formatGoal(result.goal)}`, { goal: result.goal, sessionId: target.sessionId });
      });
    },
    renderCall(args, theme, context) {
      return renderToolCall(theme, "goal_create", args.prompt, context, args);
    },
    renderResult(result, options, theme, context) {
      const failed = toolResultFailed(result, context);
      const goal = result.details?.goal;
      const label = "Goal created";
      const detail = goal ? `Goal created • every ${goal.intervalMs}ms\nPrompt: ${goal.prompt}` : "";
      return renderToolOutcome(theme, label, { ...options, expanded: Boolean(context.expanded ?? options.expanded) }, failed, detail, result, context.args);
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
      const result = target.pool.pause(params.reason);
      if (!result.ok) return errorResult(result.error, { reason: result.error });
      return success(`Goal paused: ${params.reason}`, { goal: result.goal, sessionId: target.sessionId });
      });
    },
    renderCall(args, theme, context) {
      return renderToolCall(theme, "goal_pause", args.reason, context, args);
    },
    renderResult(result, options, theme, context) {
      const failed = toolResultFailed(result, context);
      const goal = result.details?.goal;
      return renderToolOutcome(theme, "Goal paused", { ...options, expanded: Boolean(context.expanded ?? options.expanded) }, failed, goal?.pauseReason ?? "", result, context.args);
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
      const result = target.pool.resume();
      if (!result.ok) return errorResult(result.error, { reason: result.error });
      return success(`Goal resumed: ${result.goal.status}`, { goal: result.goal, sessionId: target.sessionId });
      });
    },
    renderCall(_args, theme, context) {
      return renderToolCall(theme, "goal_resume", undefined, context, {});
    },
    renderResult(result, options, theme, context) {
      const failed = toolResultFailed(result, context);
      const goal = result.details?.goal;
      return renderToolOutcome(theme, "Goal resumed", { ...options, expanded: Boolean(context.expanded ?? options.expanded) }, failed, goal?.prompt ?? "", result, context.args);
    },
  });

  pi.registerTool({
    name: "goal_status",
    label: "Goal status",
    description: "Show the complete current goal record for this root session.",
    parameters: goalNoArgsParams,
    async execute(_toolCallId: string, _params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<GoalToolResult> {
      return processWithLog({ operation: TOOL_OPERATIONS.GOALS_EXECUTE, parameters: { action: "status" } }, async () => {
      const target = goalOrError(ctx);
      if ("content" in target) return target;
      const goal = target.pool.get();
      if (!goal) return errorResult("no goal exists for this session", { reason: "no goal exists for this session" });
      return success(formatGoal(goal), { goal, sessionId: target.sessionId });
      });
    },
    renderCall(_args, theme, context) {
      return renderToolCall(theme, "goal_status", undefined, context, {});
    },
    renderResult(result, options, theme, context) {
      const failed = toolResultFailed(result, context);
      const goal = result.details?.goal;
      const label = goal ? `Goal status • ${goal.status}` : "Goal status • none";
      const detail = goal ? formatGoal(goal) : "";
      return renderToolOutcome(theme, label, { ...options, expanded: Boolean(context.expanded ?? options.expanded) }, failed, detail, result, context.args);
    },
  });

  pi.registerTool({
    name: "goal_clear",
    label: "Clear goal",
    description: "Clear my current goal only when I decide it is complete. Set isComplete to false to keep the goal and inspect its current context.",
    parameters: goalClearParams,
    async execute(_toolCallId: string, params: GoalClearParams, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<GoalToolResult> {
      return processWithLog({ operation: TOOL_OPERATIONS.GOALS_EXECUTE, parameters: { action: "clear", isComplete: params.isComplete } }, async () => {
      const target = goalOrError(ctx);
      if ("content" in target) return target;
      const goal = target.pool.get();
      if (!goal) return errorResult("no goal exists to clear for this session", { reason: "no goal exists to clear for this session" });
      if (!params.isComplete) return success(notCompleteAdvice(goal), { goal, sessionId: target.sessionId });
      if (!target.pool.clear()) return errorResult("no goal exists to clear for this session", { reason: "no goal exists to clear for this session" });
      return success("Congratulations, the goal was completed and cleared.", { goal, sessionId: target.sessionId });
      });
    },
    renderCall(args, theme, context) {
      return renderToolCall(theme, "goal_clear", String(args.isComplete), context, args);
    },
    renderResult(result, options, theme, context) {
      const failed = toolResultFailed(result, context);
      const retained = Boolean(result.details?.goal) && !Boolean(result.content?.[0] && "text" in result.content[0] && typeof result.content[0].text === "string" && result.content[0].text.includes("completed and cleared"));
      const goal = result.details?.goal;
      return renderToolOutcome(theme, retained ? "Goal retained" : "Goal cleared", { ...options, expanded: Boolean(context.expanded ?? options.expanded) }, failed, goal?.prompt ?? "", result, context.args);
    },
  });
}
