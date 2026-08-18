import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { renderToolDetail, renderToolOutcome, toolResultFailed } from "../render.ts";
import {
  makeJobId,
  runForegroundAgent,
  spawnWithControl,
} from "../agent-execution.ts";
import { isInSessionScope, resumeDisposition, type Job } from "@xzy-ai/core";
import { TOOL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import {
  backgroundModeError,
  createCachedAgentDiscovery,
  getChildPool,
  prepareResumeSessionFile,
  recordNewJob,
  resolveSettingsForProject,
  runBackgroundJob,
} from "@xzy-ai/runtime";
import { agentParams, type AgentParams } from "../tools.ts";
import type { AgentDetails, AgentErrorDetails } from "../types.ts";
import { formatResumingAgentText, formatRunningAgentText } from "./status.ts";
import { callerFor } from "../caller.ts";
import { errorResult, textResult } from "../results.ts";

/**
 * Register the `agent` tool.
 *
 * The root host delegates to a subagent in the background and delivers the
 * result asynchronously. A child or descendant call runs the descendant
 * foreground within the same tool invocation and receives its result inline;
 * children never use background delivery.
 */
export function registerAgentTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "agent",
    label: "Agent",
    description: [
      "Root host: delegate work to a specialized in-process subagent in the background (immediate job id, result delivered later).",
      "Child/descendant: run the descendant subagent foreground and await its result before returning.",
      "Prefer agent_id when continuing related work: steering or resuming preserves transcript and context.",
      "A single response may issue no more than the validated agents.maxParallelAgents setting for the active project.",
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
      // Every model-visible agent call logs as one correlated boundary, from
      // the parallel-budget and scope checks through the spawn/steer decision.
      return processWithLog({ operation: TOOL_OPERATIONS.AGENT_EXECUTE, parameters: { subagentType: params.subagent_type, prompt: params.prompt } }, () =>
        executeAgentCall(params, ctx, _signal),
      );
    },
    renderCall(args, theme, context) {
      return renderToolDetail(theme, "agent", `${args.subagent_type} • ${args.description}`, 96, context, args);
    },
    renderResult(result, options, theme, context) {
      const details = result.details;
      const failed = toolResultFailed(result, context);
      const status = details && "status" in details ? details.status : failed ? "failed" : "completed";
      const detailsRecord = details && typeof details === "object" ? details as unknown as Record<string, unknown> : undefined;
      const jobTitle = context.args && typeof context.args === "object" && "description" in context.args
        ? String((context.args as { description?: unknown }).description ?? "")
        : detailsRecord && typeof detailsRecord.description === "string" ? detailsRecord.description : "agent";
      const label = `Agent ${status} • ${jobTitle}`;
      const prompt = !failed && context.expanded && context.args && typeof context.args === "object" && "prompt" in context.args
        ? `Instructions: ${String((context.args as { prompt?: unknown }).prompt ?? "")}`
        : detailsRecord && context.expanded && typeof detailsRecord.prompt === "string" ? `Instructions: ${detailsRecord.prompt}` : "";
      return renderToolOutcome(theme, label, { ...options, expanded: Boolean(context.expanded ?? options.expanded) }, failed, prompt, result, context.args);
    },
  });
}

async function executeAgentCall(
  params: AgentParams,
  ctx: ExtensionContext,
  _signal: AbortSignal | undefined,
): Promise<AgentToolResult<AgentDetails | AgentErrorDetails>> {
  const pool = getChildPool(ctx.cwd, ctx.sessionManager.getSessionId());

  const countAgentCall = (): AgentToolResult<AgentDetails | AgentErrorDetails> | undefined => {
    const maxParallelAgents = resolveSettingsForProject(ctx.cwd).agents.maxParallelAgents;
    if (pool.concurrency.countAgentCall(maxParallelAgents)) return undefined;
    return errorResult(
      `too many parallel agents in one response: at most ${maxParallelAgents} agent calls are allowed`,
      { jobId: undefined, reason: "parallel agent limit exceeded" },
    );
  };

  // The caller's own job id is its child session id when that session is
  // itself a registered job; the root orchestrator session is not a job, so
  // it controls and views every job in the project.
  const caller = callerFor(ctx, pool);
  const isChildCaller = caller.jobId !== undefined || pool.registry.getBySessionId(ctx.sessionManager.getSessionId()) !== undefined;

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
          subagentType: job.subagentType,
          description: job.description,
          prompt: params.prompt,
          status: "running",
        },
      );
    }
    // A background launch may already be in flight for this job (concurrent
    // tool calls resuming the same terminal job). Only one child may start;
    // later callers acknowledge without consuming the parallel budget.
    if (pool.launchingJobs.has(job.jobId)) {
      return textResult(
        `Agent ${job.subagentType} (${params.agent_id}) is already being started or resumed; its result will arrive when it settles.`,
        { jobId: job.jobId, subagentType: job.subagentType, description: job.description, prompt: params.prompt, status: job.status },
      );
    }
    // Resume (or retry a created job) in place. Its job id, lineage, and
    // transcript remain stable, so resuming never creates duplicate
    // registry records or copied session files.
    if (!isChildCaller) {
      const backgroundError = backgroundModeError(ctx.mode);
      if (backgroundError) {
        return errorResult("background agents are available only in TUI mode", {
          jobId: job.jobId,
          reason: backgroundError,
        });
      }
    }
    const budgetError = countAgentCall();
    if (budgetError) return budgetError;
    if (disposition.kind === "resume" && !job.sessionFile) {
      return errorResult(`agent ${params.agent_id} has no stored transcript to resume`, {
        jobId: params.agent_id,
        reason: "no stored transcript",
      });
    }
    return startAgent(params, ctx, { existingJob: job }, _signal);
  }

  // Root-host calls are background; child and descendant calls are
  // foreground (their SDK mode is `print` but nested spawns await).
  if (!isChildCaller) {
    const backgroundError = backgroundModeError(ctx.mode);
    if (backgroundError) {
      return errorResult("background agents are available only in TUI mode", {
        jobId: undefined,
        reason: backgroundError,
      });
    }
  }
  const budgetError = countAgentCall();
  if (budgetError) return budgetError;
  return startAgent(params, ctx, {}, _signal);
}

/**
 * Start an agent job.
 *
 * Root-host calls record the job, queue it for a background run, and return
 * immediately with the running-text acknowledgement. A child/descendant call
 * runs the descendant foreground within this invocation and returns the
 * descendant's terminal status plus its output. Existing jobs are resumed in
 * place, preserving identity and transcript.
 */
async function startAgent(
  params: AgentParams,
  ctx: ExtensionContext,
  resume: { existingJob?: Job } = {},
  parentSignal?: AbortSignal,
): Promise<AgentToolResult<AgentDetails | AgentErrorDetails>> {
  return startAgentInner(params, ctx, resume, parentSignal);
}

async function startAgentInner(
  params: AgentParams,
  ctx: ExtensionContext,
  resume: { existingJob?: Job } = {},
  parentSignal?: AbortSignal,
): Promise<AgentToolResult<AgentDetails | AgentErrorDetails>> {
  const pool = getChildPool(ctx.cwd, ctx.sessionManager.getSessionId());

  if (!ctx.model) {
    return errorResult("no model available to run the child session", {
      jobId: resume.existingJob?.jobId,
      reason: "no model available",
    });
  }
  const agent = createCachedAgentDiscovery(ctx.cwd).resolve(params.subagent_type);
  if (!agent) {
    return errorResult(
      `unknown subagent_type: ${params.subagent_type}`,
      { jobId: resume.existingJob?.jobId, reason: "unknown subagent_type" },
    );
  }

  const existingJob = resume.existingJob;
  const parentSessionId = ctx.sessionManager.getSessionId();
  const caller = callerFor(ctx, pool);
  const parent = caller.jobId ? pool.registry.get(caller.jobId) : pool.registry.getBySessionId(parentSessionId);
  const isChildCaller = parent !== undefined;
  const allParentAgentIds = parent ? [...(parent.parentAgentIds ?? []), parent.jobId] : [];

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
  // A fresh spawn must never collide with an existing id: the registry is the
  // in-memory authority, so check it before recording (6^36 guesses is enough).
  let jobId = makeJobId();
  for (let attempt = 0; attempt < 5 && pool.registry.get(jobId) !== undefined; attempt += 1) {
    jobId = makeJobId();
  }
  let job: Job;
  try {
    job = existingJob ?? recordNewJob(pool.registry, {
      jobId,
      status: "queued",
      description: params.description,
      subagentType: params.subagent_type,
      parentSessionId,
      parentJobId: parent?.jobId,
      rootJobId: parent?.rootJobId,
      depth: parent ? parent.depth + 1 : undefined,
      sessionFile,
      sessionId: jobId,
      parentAgentIds: allParentAgentIds,
    });
  } catch (error) {
    return errorResult(`could not record agent ${jobId}: ${error instanceof Error ? error.message : String(error)}`, {
      jobId,
      reason: "job recording failed",
    });
  }
  if (existingJob) {
    // Terminal and created jobs are explicitly re-queued in place. Resetting
    // delivered prevents an earlier terminal result from suppressing reuse.
    pool.registry.updateJob(existingJob.jobId, { status: "queued", delivered: false });
  }

  const spawnOptions = {
    parentSessionId,
    rootSessionId: pool.rootSessionIdFor(parentSessionId),
    parentAgentIds: existingJob?.parentAgentIds ?? allParentAgentIds,
    sessionFile,
  } as const;

  // A child/descendant caller runs the descendant foreground and receives its
  // result inline; only the root host uses fire-and-forget background delivery.
  if (isChildCaller) {
    const result = await runForegroundAgent(pool, params, ctx, job, agent, { ...spawnOptions, parentSignal });
    const status: AgentDetails["status"] =
      result.status === "completed" ? "completed" : result.status === "aborted" ? "cancelled" : "failed";
    const prefix = existingJob ? "Resumed" : "Agent";
    return textResult(`${prefix} ${job.subagentType} (${job.jobId}) ${status}.\n${result.output}`, {
      jobId: job.jobId,
      subagentType: job.subagentType,
      description: job.description,
      prompt: params.prompt,
      status,
      result: result.output,
    });
  }

  // Root host: background delivery. The child lifecycle runs under the shared
  // concurrency gate, so a call beyond the cap stays `queued` until it acquires
  // a slot. `signal: undefined` keeps the child alive when the turn is cancelled.
  // A failed spawn (e.g. an unresolvable frontmatter or global config model)
  // surfaces through the UI notification channel so the user can correct the
  // configuration manually; the failure text is also delivered to the parent
  // transcript through the normal background result path.
  const parentSessionFile = ctx.sessionManager.getSessionFile() ?? "";
  const launch = runBackgroundJob(
    { registry: pool.registry, delivery: pool.deliveryFor(pool.rootSessionIdFor(parentSessionId)) },
    job,
    {
      parentSessionFile,
      onChildFailed: (message) => {
        if (ctx.mode === "tui") {
          ctx.ui.notify(message, "error");
        }
      },
      runChild: () =>
        spawnWithControl(pool, params, ctx, job, agent, {
          ...spawnOptions,
          signal: undefined,
        }),
    },
  );
  // Hold a launch lease so a concurrent resume of this job never starts a
  // second child, and keep the terminal outcome visible if delivery/persist
  // fails: a background failure must never surface as an unhandled rejection.
  pool.launchingJobs.set(job.jobId, launch);
  void launch.then(
    () => pool.launchingJobs.delete(job.jobId),
    () => {
      pool.launchingJobs.delete(job.jobId);
      try {
        pool.registry.updateJob(job.jobId, { status: "failed" });
      } catch {
        // The registry may already be terminal; the job stays visible either way.
      }
    },
  );

  return textResult(existingJob ? formatResumingAgentText(job.subagentType, job.jobId) : formatRunningAgentText(job.subagentType, job.jobId), {
    jobId: job.jobId,
    subagentType: job.subagentType,
    description: job.description,
    prompt: params.prompt,
    status: "queued",
  });
}
