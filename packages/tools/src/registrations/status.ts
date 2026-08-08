import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isInSessionScope, statusFor } from "@xzy-ai/core";
import { getChildPool } from "@xzy-ai/runtime";
import { statusParams, type StatusParams } from "../tools.ts";
import type { StatusDetails } from "../types.ts";
import { callerFor } from "../caller.ts";
import { toJobSummary } from "../job-summary.ts";
import { errorResult, textResult } from "../results.ts";

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
      return textResult(`Agent ${params.job_id} is ${job.status}.`, {
        status: job.status,
        job: toJobSummary(job),
        controllable: result.controllable,
      });
    },
  });
}