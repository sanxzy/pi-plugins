import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  agentExecute,
  makeJobId,
  spawnWithControl,
} from "../agent-execution.ts";
import { resumeDisposition } from "@xzy-ai/core";
import { createAgentDiscovery } from "@xzy-ai/runtime";
import { backgroundModeError, runBackgroundJob } from "@xzy-ai/runtime";
import { getChildPool } from "@xzy-ai/runtime";
import { copySessionFile } from "@xzy-ai/runtime";
import { recordNewJob } from "@xzy-ai/runtime";
import { MAX_PARALLEL_AGENTS } from "@xzy-ai/core";
import { agentParams, type AgentParams } from "../tools.ts";
import type { AgentDetails, AgentErrorDetails } from "../types.ts";
import { callerFor } from "../caller.ts";
import { errorResult, textResult } from "../results.ts";

/**
 * Register the `agent` tool.
 *
 * Delegates work to a specialized in-process subagent. `agent_id` resumes or
 * steers an existing job; `background=true` runs the child off the main turn
 * and delivers the result to the direct parent (TUI only).
 */
export function registerAgentTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "agent",
    label: "Agent",
    description: [
      "Delegate work to a specialized in-process subagent.",
      "Use background=true only in the TUI; agent_id resumes or steers an existing job.",
      `A single response may issue at most ${MAX_PARALLEL_AGENTS} agent calls.`,
    ].join(" "),
    promptSnippet: "Delegate a focused task to a specialized subagent.",
    parameters: agentParams,
    async execute(
      _toolCallId: string,
      params: AgentParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<AgentDetails | AgentErrorDetails>> {
      const backgroundError = params.background ? backgroundModeError(ctx.mode) : undefined;
      if (backgroundError) {
        return errorResult("background agents are available only in TUI mode", {
          jobId: undefined,
          reason: backgroundError,
        });
      }

      const pool = getChildPool(ctx.cwd);

      // A single model response may issue at most MAX_PARALLEL_AGENTS agent calls.
      // The counter is shared through the pool and reset on each turn_start, so
      // separate responses get independent budgets.
      if (!pool.concurrency.countAgentCall(MAX_PARALLEL_AGENTS)) {
        return errorResult(
          `too many parallel agents in one response: at most ${MAX_PARALLEL_AGENTS} agent calls are allowed`,
          { jobId: undefined, reason: "parallel agent limit exceeded" },
        );
      }

      // The caller's own job id is its child session id when that session is
      // itself a registered job; the root orchestrator session is not a job, so
      // it controls and views every job in the project.
      const caller = callerFor(ctx, pool);

      // Address an existing job: a running job is steered, a finished job is
      // resumed from its stored transcript, and a job with no transcript yet is
      // re-spawned fresh. The parallel-call counter above is deliberately not
      // consumed by a resume/steer that only addresses an existing job.
      if (params.agent_id) {
        const job = pool.registry.get(params.agent_id);
        if (!job) {
          return errorResult(`unknown agent id: ${params.agent_id}`, {
            jobId: params.agent_id,
            reason: "unknown agent id",
          });
        }
        const disposition = resumeDisposition(caller, job, (jobId) => pool.registry.get(jobId));
        if (disposition.kind === "reject") {
          return errorResult(`cannot resume agent ${params.agent_id}: ${disposition.reason}`, {
            jobId: params.agent_id,
            reason: disposition.reason,
          });
        }
        if (disposition.kind === "steer") {
          const control = pool.liveChildren.get(job.jobId);
          if (!control) {
            return errorResult(`agent ${params.agent_id} is running but has no live child to steer`, {
              jobId: job.jobId,
              reason: "no live child",
            });
          }
          await control.steer(params.prompt);
          return textResult(`Steered running agent ${job.jobId}.`, {
            jobId: job.jobId,
            status: "running",
          });
        }
        if (disposition.kind === "fresh-spawn") {
          return agentExecute(params, ctx, caller, { parentJobId: job.jobId });
        }
        // Resume from the stored transcript.
        if (!job.sessionFile) {
          return errorResult(`agent ${params.agent_id} has no stored transcript to resume`, {
            jobId: job.jobId,
            reason: "no stored transcript",
          });
        }
        const resumeJobId = makeJobId();
        const parentSessionId = ctx.sessionManager.getSessionId();
        let copyPath: string | undefined;
        try {
          copyPath = copySessionFile(job.sessionFile, resumeJobId, ctx.cwd, parentSessionId);
        } catch {
          copyPath = undefined;
        }
        if (!copyPath) {
          return errorResult(`could not copy the transcript for agent ${params.agent_id}`, {
            jobId: job.jobId,
            reason: "transcript copy failed",
          });
        }
        return agentExecute(params, ctx, caller, {
          jobId: resumeJobId,
          parentJobId: job.jobId,
          sessionFile: copyPath,
        });
      }

      // Background: validate before recording so an invalid request never
      // consumes a job id. The child runs off the main turn and its result is
      // delivered to the direct parent when it finishes.
      if (params.background) {
        if (!ctx.model) {
          return errorResult("no model available to run the child session", {
            jobId: undefined,
            reason: "no model available",
          });
        }
        const agent = createAgentDiscovery(ctx.cwd).resolve(params.subagent_type);
        if (!agent) {
          return errorResult(
            `unknown subagent_type: ${params.subagent_type}`,
            { jobId: undefined, reason: "unknown subagent_type" },
          );
        }

        // The direct-parent session file keys result delivery and the parent
        // session id scopes the job's storage folder.
        const parentSessionFile = ctx.sessionManager.getSessionFile() ?? "";
        const parentSessionId = ctx.sessionManager.getSessionId();
        const jobId = makeJobId();
        const job = recordNewJob(pool.registry, {
          jobId,
          status: "queued",
          description: params.description,
          subagentType: params.subagent_type,
          sessionId: jobId,
          parentSessionId,
        });

        // The direct-parent session file keys result delivery. The realisation
        // below is async, so the job is acknowledged as `running` to match the
        // contract (return immediately with the job id and a running
        // acknowledgement); a gate slot is acquired before the child runs.
        pool.registry.updateJob(job.jobId, { status: "running" });

        // The child lifecycle runs under the shared concurrency gate, exactly
        // like the foreground path, so a call beyond the cap stays `queued` and
        // starts when a slot frees. `signal: undefined` deliberately keeps the
        // child alive when the main turn is cancelled; only quitting the PI
        // process interrupts it (Phase 7).
        void runBackgroundJob(
          pool,
          job,
          {
            parentSessionFile,
            runChild: () =>
              spawnWithControl(pool, params, ctx, job, agent, {
                parentSessionId,
                signal: undefined,
              }),
          },
        );

        return textResult(
          `Accepted background agent ${job.jobId}. Its result will be delivered when it finishes.`,
          { jobId: job.jobId, status: job.status },
        );
      }

      return agentExecute(params, ctx, caller);
    },
  });
}