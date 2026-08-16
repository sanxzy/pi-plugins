import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canCancel, isInSessionScope } from "@xzy-ai/core";
import { TOOL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { abortJobTree, getChildPool } from "@xzy-ai/runtime";
import { cancelParams, type CancelParams } from "../tools.ts";
import type { CancelDetails } from "../types.ts";
import { callerFor } from "../caller.ts";
import { errorResult, textResult } from "../results.ts";
import { renderToolResult, toolResultFailed } from "../render.ts";

export function registerCancelTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "agent_cancel",
    label: "Cancel agent",
    description: "Cancel a descendant subagent job by id.",
    parameters: cancelParams,
    async execute(
      _toolCallId: string,
      params: CancelParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<CancelDetails>> {
      return processWithLog({ operation: TOOL_OPERATIONS.CANCEL_EXECUTE, parameters: { jobId: params.job_id } }, async () => {
      const pool = getChildPool(ctx.cwd);
      const caller = callerFor(ctx, pool);
      const job = pool.registry.get(params.job_id);
      if (!job) {
        return errorResult(`unknown job id: ${params.job_id}`, {
          jobId: params.job_id,
          success: false,
          reason: "unknown job id",
        });
      }
      if (!isInSessionScope(caller, job, (jobId) => pool.registry.get(jobId))) {
        return errorResult(`unknown job id: ${params.job_id}`, {
          jobId: params.job_id,
          success: false,
          reason: "unknown job id",
        });
      }
      const decision = canCancel(caller, job, (jobId) => pool.registry.get(jobId));
      if (!decision.allowed) {
        return textResult(`Agent ${params.job_id} is not cancellable: ${decision.reason}.`, {
          jobId: params.job_id,
          subagentType: job.subagentType,
          success: false,
          status: job.status,
          allowed: false,
          reason: decision.reason,
        });
      }

      const control = pool.liveChildren.get(job.jobId);
      const abortController = pool.jobAbortControllers?.get(job.jobId);
      if (!control && !abortController && pool.registry.get(job.jobId)?.status === "running") {
        // The durable record outlived its launching host: no live child or
        // abort controller remains, so the job can never settle on its own.
        // Reconcile the phantom live job to a terminal cancelled state.
        pool.registry.updateJob(job.jobId, { status: "cancelled" });
        return textResult(`Agent ${params.job_id} was cancelled.`, {
          jobId: params.job_id,
          subagentType: job.subagentType,
          success: true,
          status: "cancelled",
        });
      }

      // Cancel the target and its entire recursive descendant subtree.
      // A parent foreground call can be blocked awaiting its own child; abort
      // descendants first so the parent reaches idle instead of hanging.
      await abortJobTree(
        {
          registry: pool.registry,
          liveChildren: pool.liveChildren,
          jobAbortControllers: pool.jobAbortControllers,
        },
        job.jobId,
        "cancelled",
      );
      return textResult(`Agent ${params.job_id} was cancelled.`, {
        jobId: params.job_id,
        subagentType: job.subagentType,
        success: true,
        status: "cancelled",
      });
      });
    },
    renderResult(result, options, theme, context) {
      const details = result.details && typeof result.details === "object" ? result.details as unknown as Record<string, unknown> : {};
      const success = details.success === true;
      const type = typeof details.subagentType === "string" ? details.subagentType : "agent";
      const jobId = typeof details.jobId === "string" ? details.jobId : "unknown";
      return renderToolResult(theme, `Agent ${type} • ${jobId} ${success ? "cancelled" : "not cancellable"}`, toolResultFailed(result, context) || !success, options.isPartial);
    },
  });
}