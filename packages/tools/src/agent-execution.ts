import type {
  AgentToolResult,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedAgent } from "@xzy-ai/core";
import type { Job } from "@xzy-ai/core";
import type { ChildRunResult } from "@xzy-ai/core";
import type { ChildPool } from "@xzy-ai/runtime";
import { spawnChildSession } from "@xzy-ai/runtime";
import { recordNewJob } from "@xzy-ai/runtime";
import { createAgentDiscovery } from "@xzy-ai/runtime";
import { getChildPool } from "@xzy-ai/runtime";
import type { ControlCaller } from "@xzy-ai/core";
import { errorResult, textResult } from "./results.ts";
import type { AgentDetails, AgentErrorDetails } from "./types.ts";
import type { AgentParams } from "./tools.ts";

/**
 * Run a new or resumed job in the foreground and settle its registry record.
 *
 * Shared by fresh `agent` calls and by the resume/fresh-spawn branches of
 * `agent(agent_id, prompt)`. `parentJobId`/`sessionFile` carry the resumed
 * lineage and transcript; a fresh call leaves both unset.
 */
export async function agentExecute(
  params: AgentParams,
  ctx: ExtensionContext,
  caller: ControlCaller,
  options: { jobId?: string; parentJobId?: string; sessionFile?: string } = {},
): Promise<AgentToolResult<AgentDetails | AgentErrorDetails>> {
  const pool = getChildPool(ctx.cwd);

  // Foreground: validate before creating a queued record. The lifecycle
  // deliberately has no queued → failed transition; setup failures after
  // gate admission are recorded as running → failed instead.
  if (!ctx.model) {
    return errorResult("no model available to run the child session", {
      jobId: options.parentJobId,
      reason: "no model available",
    });
  }
  const agent = createAgentDiscovery(ctx.cwd).resolve(params.subagent_type);
  if (!agent) {
    return errorResult(
      `unknown subagent_type: ${params.subagent_type}`,
      { jobId: options.parentJobId, reason: "unknown subagent_type" },
    );
  }

  const parent = options.parentJobId ? pool.registry.get(options.parentJobId) : undefined;
  const job = recordNewJob(pool.registry, {
    jobId: options.jobId ?? makeJobId(),
    status: "queued",
    description: params.description,
    subagentType: params.subagent_type,
    parentJobId: parent?.jobId,
    rootJobId: parent?.rootJobId,
    depth: parent ? parent.depth + 1 : undefined,
    sessionFile: options.sessionFile,
  });

  // The child run is admitted through the shared concurrency gate. The
  // `queued → running` transition is recorded at the exact moment the slot is
  // acquired, so a job waiting for a slot stays observable as `queued`.
  const result = await spawnWithControl(pool, params, ctx, job, agent, {
    parentSessionId: ctx.sessionManager.getSessionId(),
    sessionFile: options.sessionFile,
    signal: ctx.signal,
  });

  if (!result) {
    pool.registry.updateJob(job.jobId, { status: "failed" });
    return errorResult(`could not spawn child for ${params.subagent_type}`, {
      jobId: job.jobId,
      reason: "spawn failed",
    });
  }

  // Mark the job terminal and persist the child's transcript. If the job was
  // already cancelled by `agent_cancel` mid-run, the status update is a legal
  // no-op, so persist the session file in a separate update.
  pool.registry.updateJob(job.jobId, { status: settleStatus(result.status) });
  pool.registry.updateJob(job.jobId, { sessionFile: result.sessionFile });

  if (result.status === "completed") {
    return textResult(`Agent ${job.jobId} completed:\n${result.output}`, {
      jobId: job.jobId,
      status: "completed",
      result: result.output,
    });
  }
  return errorResult(
    result.status === "aborted"
      ? `agent ${job.jobId} was aborted`
      : `agent ${job.jobId} failed: ${result.output}`,
    { jobId: job.jobId, reason: result.status === "aborted" ? "aborted" : "failed" },
  );
}

/**
 * Spawn a child for a new or resumed job under the shared gate.
 *
 * The live-child handle is registered before the child exists so a steer or
 * cancel issued while the child is still creating finds the job; it is removed
 * once the child settles. The `queued → running` transition is recorded at the
 * exact moment the gate slot is acquired.
 */
export async function spawnWithControl(
  pool: ChildPool,
  params: AgentParams,
  ctx: ExtensionContext,
  job: Job,
  agent: ResolvedAgent,
  options: { parentSessionId: string; sessionFile?: string; signal?: AbortSignal },
): Promise<ChildRunResult | undefined> {
  try {
    return await spawnChildSession({
      jobId: job.jobId,
      cwd: ctx.cwd,
      agent,
      prompt: params.prompt,
      parentSessionId: options.parentSessionId,
      sessionFile: options.sessionFile,
      model: ctx.model,
      signal: options.signal,
      onControl: (control) => {
        pool.liveChildren.set(job.jobId, control);
      },
      run: (operation) =>
        pool.concurrency.run(() => {
          pool.registry.updateJob(job.jobId, { status: "running" });
          return operation();
        }),
    });
  } finally {
    // The child has settled; a later steer or cancel must not find it.
    pool.liveChildren.delete(job.jobId);
  }
}

/** Stable job id, unique per call. */
export function makeJobId(): string {
  return `job-${Math.random().toString(36).slice(2, 8)}`;
}

/** Map a child terminal status onto the job status union. */
function settleStatus(status: "completed" | "aborted" | "failed"): "completed" | "cancelled" | "failed" {
  return status === "completed" ? "completed" : status === "aborted" ? "cancelled" : "failed";
}
