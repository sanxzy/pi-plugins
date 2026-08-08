import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canCancel, isInSessionScope } from "@xzy-ai/core";
import { getChildPool } from "@xzy-ai/runtime";
import { cancelParams, type CancelParams } from "../tools.ts";
import type { CancelDetails } from "../types.ts";
import { callerFor } from "../caller.ts";
import { errorResult, textResult } from "../results.ts";

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
          success: false,
          status: job.status,
          allowed: false,
          reason: decision.reason,
        });
      }

      const control = pool.liveChildren.get(job.jobId);
      if (!control) {
        return textResult(`Agent ${params.job_id} is running but has no live child to abort.`, {
          jobId: params.job_id,
          success: false,
          status: job.status,
          allowed: false,
          reason: "no live child",
        });
      }

      // Abort the child run; the abort resolves the child's own prompt() and its
      // result handler maps the aborted status to cancelled. Marking the job
      // cancelled here stays idempotent when the handler follows up.
      await control.abort();
      pool.registry.updateJob(job.jobId, { status: "cancelled" });
      return textResult(`Agent ${params.job_id} was cancelled.`, {
        jobId: params.job_id,
        success: true,
        status: "cancelled",
      });
    },
  });
}