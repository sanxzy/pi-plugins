import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  makeJobId,
  spawnWithControl,
} from "../agent-execution.ts";
import { isInSessionScope, resumeDisposition, type Job } from "@xzy-ai/core";
import { createAgentDiscovery } from "@xzy-ai/runtime";
import { backgroundModeError, runBackgroundJob } from "@xzy-ai/runtime";
import { getChildPool } from "@xzy-ai/runtime";
import { prepareResumeSessionFile, recordNewJob } from "@xzy-ai/runtime";
import { MAX_PARALLEL_AGENTS } from "@xzy-ai/core";
import { agentParams, type AgentParams } from "../tools.ts";
import type { AgentDetails, AgentErrorDetails } from "../types.ts";
import { formatResumingAgentText, formatRunningAgentText } from "./status.ts";
import { callerFor } from "../caller.ts";
import { errorResult, textResult } from "../results.ts";

/**
 * Register the `agent` tool.
 *
 * Delegates work to a specialized in-process subagent in the background. A call
 * without `agent_id` spawns a new background job; `agent_id` steers a running
 * job or resumes a finished one in the background. Every result is delivered to
 * the direct parent when the child settles.
 */
export function registerAgentTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "agent",
    label: "Agent",
    description: [
      "Delegate work to a specialized in-process subagent in the background.",
      "A call without agent_id spawns a new background job; agent_id steers a running job or resumes a finished one.",
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
      const pool = getChildPool(ctx.cwd);

      const countAgentCall = (): AgentToolResult<AgentDetails | AgentErrorDetails> | undefined => {
        if (pool.concurrency.countAgentCall(MAX_PARALLEL_AGENTS)) return undefined;
        return errorResult(
          `too many parallel agents in one response: at most ${MAX_PARALLEL_AGENTS} agent calls are allowed`,
          { jobId: undefined, reason: "parallel agent limit exceeded" },
        );
      };

      // The caller's own job id is its child session id when that session is
      // itself a registered job; the root orchestrator session is not a job, so
      // it controls and views every job in the project.
      const caller = callerFor(ctx, pool);

      // Address an existing job: a running job is steered, a finished job is
      // resumed in the background, and a job with no transcript yet is
      // re-spawned in the background. The parallel-call counter above is
      // deliberately not consumed by a steer, which does not launch a child.
      if (params.agent_id) {
        const job = pool.registry.get(params.agent_id);
        if (!job) {
          return errorResult(`unknown agent id: ${params.agent_id}`, {
            jobId: params.agent_id,
            reason: "unknown agent id",
          });
        }
        if (!isInSessionScope(caller, job, (jobId) => pool.registry.get(jobId))) {
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
          return textResult(
            `Steered agent ${job.subagentType} (${params.agent_id}). The agent keeps its running context and will notify you when it settles. Take a rest while the agent works. Do not poll agent tools or use sleep-based waiting. Simply end your response and let the agents notify you when they finish.`,
            {
              jobId: job.jobId,
              status: "running",
            },
          );
        }
        // Resume (or retry a created job) in place. The TUI gate applies to
        // every path that launches a child, while steering above remains direct.
        const backgroundError = backgroundModeError(ctx.mode);
        if (backgroundError) {
          return errorResult("background agents are available only in TUI mode", {
            jobId: job.jobId,
            reason: backgroundError,
          });
        }
        // Re-queue the existing job in place. Its job id, lineage, and
        // transcript remain stable, so resuming never creates duplicate
        // registry records or copied session files.
        const budgetError = countAgentCall();
        if (budgetError) return budgetError;
        if (disposition.kind === "resume" && !job.sessionFile) {
          return errorResult(`agent ${params.agent_id} has no stored transcript to resume`, {
            jobId: job.jobId,
            reason: "no stored transcript",
          });
        }
        return startBackgroundAgent(params, ctx, { existingJob: job });
      }

      // A new spawn is always background. The TUI gate protects the delivery
      // contract: in one-shot modes the parent exits before the child settles.
      const backgroundError = backgroundModeError(ctx.mode);
      if (backgroundError) {
        return errorResult("background agents are available only in TUI mode", {
          jobId: undefined,
          reason: backgroundError,
        });
      }

      const budgetError = countAgentCall();
      if (budgetError) return budgetError;
      return startBackgroundAgent(params, ctx);
    },
  });
}

/**
 * Start a background agent job and acknowledge it immediately.
 *
 * Validates model availability and the requested `subagent_type` before
 * recording a job so an invalid request never consumes a job id, then runs the
 * child under the shared gate and delivers its result to the direct parent.
 * `existingJob` resumes or retries one job in place, preserving its identity
 * and transcript instead of creating a duplicate record.
 */
function startBackgroundAgent(
  params: AgentParams,
  ctx: ExtensionContext,
  resume: { existingJob?: Job } = {},
): AgentToolResult<AgentDetails | AgentErrorDetails> {
  const pool = getChildPool(ctx.cwd, ctx.sessionManager.getSessionId());

  if (!ctx.model) {
    return errorResult("no model available to run the child session", {
      jobId: resume.existingJob?.jobId,
      reason: "no model available",
    });
  }
  const agent = createAgentDiscovery(ctx.cwd).resolve(params.subagent_type);
  if (!agent) {
    return errorResult(
      `unknown subagent_type: ${params.subagent_type}`,
      { jobId: resume.existingJob?.jobId, reason: "unknown subagent_type" },
    );
  }

  const existingJob = resume.existingJob;
  const parentSessionId = ctx.sessionManager.getSessionId();
  let sessionFile: string | undefined;
  if (existingJob?.sessionFile) {
    try {
      sessionFile = prepareResumeSessionFile(existingJob.sessionFile, existingJob.jobId);
    } catch {
      return errorResult(`could not prepare the transcript for agent ${existingJob.jobId}`, {
        jobId: existingJob.jobId,
        reason: "transcript preparation failed",
      });
    }
  }
  const job = existingJob ?? recordNewJob(pool.registry, {
    jobId: makeJobId(),
    status: "queued",
    description: params.description,
    subagentType: params.subagent_type,
    parentSessionId,
  });
  if (existingJob) {
    // Terminal and created jobs are explicitly re-queued in place. The
    // transition is legal for all resumable states and resetting delivered
    // prevents an earlier terminal result from suppressing the new one.
    pool.registry.updateJob(existingJob.jobId, { status: "queued", delivered: false });
  }

  // The direct-parent session file keys result delivery and the parent session
  // id scopes the job's storage folder. The child lifecycle runs under the
  // shared concurrency gate, so a call beyond the cap stays `queued` and only
  // becomes `running` when it actually acquires a slot. `signal: undefined`
  // deliberately keeps the child alive when the main turn is cancelled; only
  // quitting the PI process interrupts it.
  const parentSessionFile = ctx.sessionManager.getSessionFile() ?? "";
  void runBackgroundJob(
    pool,
    job,
    {
      parentSessionFile,
      runChild: () =>
        spawnWithControl(pool, params, ctx, job, agent, {
          parentSessionId,
          sessionFile,
          signal: undefined,
        }),
    },
  );

  return textResult(existingJob ? formatResumingAgentText(job.subagentType, job.jobId) : formatRunningAgentText(job.subagentType, job.jobId), {
    jobId: job.jobId,
    status: "queued",
  });
}
