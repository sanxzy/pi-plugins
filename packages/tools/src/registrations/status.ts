import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isInSessionScope, statusFor } from "@xzy-ai/core";
import { TOOL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { getChildPool } from "@xzy-ai/runtime";
import { statusParams, type StatusParams } from "../tools.ts";
import type { StatusDetails } from "../types.ts";
import { callerFor } from "../caller.ts";
import { toJobSummary } from "../job-summary.ts";
import { errorResult, textResult } from "../results.ts";
import { renderToolResult, toolResultFailed } from "../render.ts";

export function formatRunningAgentText(subagentType: string, jobId: string): string {
  return `Agent ${subagentType} (${jobId}) is running. Take a rest while the agent works. Do not poll agent tools or use sleep-based waiting. Simply end your response and let the agents notify you when they finish.`;
}

export function formatResumingAgentText(subagentType: string, jobId: string): string {
  return `Resuming Agent ${subagentType} (${jobId}) is running. Take a rest while the agent works. Do not poll agent tools or use sleep-based waiting. Simply end your response and let the agents notify you when they finish.`;
}

export function registerStatusTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "agent_status",
    label: "Agent status",
    description: "Inspect the status of a descendant subagent job by id.",
    parameters: statusParams,
    async execute(
      _toolCallId: string,
      params: StatusParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<StatusDetails>> {
      return processWithLog({ operation: TOOL_OPERATIONS.STATUS_EXECUTE, parameters: { jobId: params.job_id } }, async () => {
      const pool = getChildPool(ctx.cwd);
      const caller = callerFor(ctx, pool);
      const job = pool.registry.get(params.job_id);
      if (!job) {
        return errorResult(`unknown job id: ${params.job_id}`, {
          status: "failed",
          reason: "unknown job id",
        });
      }
      const getJob = (jobId: string) => pool.registry.get(jobId);
      if (!isInSessionScope(caller, job, getJob)) {
        return errorResult(`unknown job id: ${params.job_id}`, {
          status: "failed",
          reason: "unknown job id",
        });
      }
      const result = statusFor(caller, job, getJob);
      const text = job.status === "running"
        ? formatRunningAgentText(job.subagentType, job.jobId)
        : `Agent ${params.job_id} is ${job.status}.`;
      return textResult(text, {
        status: job.status,
        job: toJobSummary(job),
        controllable: result.controllable,
      });
      });
    },
    renderResult(result, options, theme, context) {
      const details = result.details && typeof result.details === "object" ? result.details as { status?: unknown; job?: { subagentType?: unknown; jobId?: unknown; description?: unknown } } : {};
      const job = details.job;
      const type = typeof job?.subagentType === "string" ? job.subagentType : "agent";
      const jobId = typeof job?.jobId === "string" ? job.jobId : "unknown";
      const status = typeof details.status === "string" ? details.status : "unknown";
      return renderToolResult(theme, `Agent ${type} • ${jobId} ${status}`, toolResultFailed(result, context), options.isPartial);
    },
  });
}