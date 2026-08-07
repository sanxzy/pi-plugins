import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleJobs } from "@xzy-ai/core";
import { getChildPool } from "@xzy-ai/runtime";
import { jobsParams } from "../tools.ts";
import type { JobsDetails } from "../types.ts";
import { callerFor } from "../caller.ts";
import { toJobSummary } from "../job-summary.ts";
import { textResult } from "../results.ts";

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
      const pool = getChildPool(ctx.cwd);
      const caller = callerFor(ctx, pool);
      const jobs = visibleJobs(caller, pool.registry.all().values(), (jobId) => pool.registry.get(jobId)).map(toJobSummary);
      if (jobs.length === 0) {
        return textResult("No subagent jobs are currently visible.", { jobs: [] });
      }
      const lines = jobs.map((j) => `- ${j.jobId}: ${j.status} (${j.description})`).join("\n");
      return textResult(`Subagent jobs:\n${lines}`, { jobs });
    },
  });
}