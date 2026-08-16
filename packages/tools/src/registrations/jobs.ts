import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleJobs } from "@xzy-ai/core";
import { TOOL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { getChildPool } from "@xzy-ai/runtime";
import { jobsParams } from "../tools.ts";
import type { JobsDetails } from "../types.ts";
import { callerFor } from "../caller.ts";
import { toJobSummary } from "../job-summary.ts";
import { textResult } from "../results.ts";
import { renderToolOutcome, toolResultFailed } from "../render.ts";

export function registerJobsTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "agent_jobs",
    label: "List agents",
    description: "List subagent jobs visible to the current orchestrator.",
    parameters: jobsParams,
    async execute(
      _toolCallId: string,
      _params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<JobsDetails>> {
      return processWithLog({ operation: TOOL_OPERATIONS.JOBS_EXECUTE }, async () => {
      const pool = getChildPool(ctx.cwd);
      const caller = callerFor(ctx, pool);
      const jobs = visibleJobs(caller, pool.registry.all().values(), (jobId) => pool.registry.get(jobId)).map(toJobSummary);
      if (jobs.length === 0) {
        return textResult("No subagent jobs are currently visible.", { jobs: [] });
      }
      const lines = jobs.map((j) => `- ${j.jobId}: ${j.status} (${j.description})`).join("\n");
      const active = jobs.filter((j) => j.status === "running" || j.status === "queued");
      const guidance =
        active.length > 0
          ? `\n\n${active.length} subagent job(s) are still ${active.map((j) => j.status).join("/")}. Take a rest while they work. Do not poll agent tools or use sleep-based waiting. Simply end your response and let the agents notify you when they settle.`
          : "";
      return textResult(`Subagent jobs:\n${lines}${guidance}`, { jobs });
      });
    },
    renderResult(result, options, theme, context) {
      const details = result.details as JobsDetails | undefined;
      const jobs = details?.jobs ?? [];
      const label = `Agent jobs • ${jobs.length} jobs`;
      const expanded = jobs.map((job) => `• ${job.subagentType} • ${job.jobId} • ${job.status} • ${job.description}`).join("\n");
      return renderToolOutcome(theme, label, { ...options, expanded: Boolean(context.expanded ?? options.expanded) }, toolResultFailed(result, context), expanded);
    },
  });
}
