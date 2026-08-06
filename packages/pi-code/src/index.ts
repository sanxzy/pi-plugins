import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeSwitchEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { createAgentDiscovery } from "./infrastructure/agents/discovery.ts";
import type { ResolvedAgent } from "./domain/agents/agent.ts";
import {
  canCancel,
  resumeDisposition,
  statusFor,
  visibleJobs,
  type ControlCaller,
} from "./application/control/control.ts";
import type { Job } from "./domain/jobs/job.ts";
import { backgroundModeError, runBackgroundJob } from "./infrastructure/pool/background.ts";
import { getChildPool } from "./infrastructure/pool/child-pool.ts";
import { copySessionFile, spawnChildSession } from "./infrastructure/pi-sdk/child-session.ts";
import { recordNewJob } from "./infrastructure/registry/registry.ts";
import { MAX_PARALLEL_TASKS } from "./shared/constants.ts";
import {
  cancelParams,
  jobsParams,
  statusParams,
  taskParams,
  type CancelParams,
  type StatusParams,
  type TaskParams,
} from "./shared/tools.ts";
import type {
  CancelDetails,
  JobsDetails,
  StatusDetails,
  TaskDetails,
  TaskErrorDetails,
} from "./shared/types.ts";

const extensionName = "pi-code";

function textResult<T>(text: string, details: T): AgentToolResult<T> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function errorResult<T>(text: string, details: T): AgentToolResult<T> {
  return textResult(`Error: ${text}`, details);
}

function makeJobId(): string {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Public summary of a job, with no session handle or filesystem path. */
function toJobSummary(job: Job): import("./shared/types.ts").JobSummary {
  return {
    jobId: job.jobId,
    status: job.status,
    description: job.description,
    subagentType: job.subagentType,
    parentJobId: job.parentJobId,
    rootJobId: job.rootJobId,
    depth: job.depth,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

/**
 * Spawn a child for a new or resumed job under the shared gate.
 *
 * The live-child handle is registered before the child exists so a steer or
 * cancel issued while the child is still creating finds the job; it is removed
 * once the child settles. The `queued → running` transition is recorded at the
 * exact moment the gate slot is acquired.
 */
async function spawnWithControl(
  pool: ReturnType<typeof getChildPool>,
  params: TaskParams,
  ctx: ExtensionContext,
  job: Job,
  agent: ResolvedAgent,
  options: { parentSessionId: string; sessionFile?: string; signal?: AbortSignal },
): Promise<import("./domain/ports/child-session.ts").ChildRunResult | undefined> {
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

function callerFor(ctx: ExtensionContext, pool: ReturnType<typeof getChildPool>): ControlCaller {
  const sessionId = ctx.sessionManager.getSessionId();
  return { jobId: pool.registry.get(sessionId) ? sessionId : undefined };
}

function settleStatus(status: "completed" | "aborted" | "failed"): "completed" | "cancelled" | "failed" {
  return status === "completed" ? "completed" : status === "aborted" ? "cancelled" : "failed";
}

function registerTaskTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "task",
    label: "Task",
    description: [
      "Delegate work to a specialized in-process subagent.",
      "Use background=true only in the TUI; task_id resumes or steers an existing job.",
      `A single response may issue at most ${MAX_PARALLEL_TASKS} task calls.`,
    ].join(" "),
    promptSnippet: "Delegate a focused task to a specialized subagent.",
    parameters: taskParams,
    async execute(
      _toolCallId: string,
      params: TaskParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<TaskDetails | TaskErrorDetails>> {
      const backgroundError = params.background ? backgroundModeError(ctx.mode) : undefined;
      if (backgroundError) {
        return errorResult("background tasks are available only in TUI mode", {
          jobId: undefined,
          reason: backgroundError,
        });
      }

      const pool = getChildPool(ctx.cwd);

      // A single model response may issue at most MAX_PARALLEL_TASKS task calls.
      // The counter is shared through the pool and reset on each turn_start, so
      // separate responses get independent budgets.
      if (!pool.concurrency.countTaskCall(MAX_PARALLEL_TASKS)) {
        return errorResult(
          `too many parallel tasks in one response: at most ${MAX_PARALLEL_TASKS} task calls are allowed`,
          { jobId: undefined, reason: "parallel task limit exceeded" },
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
      if (params.task_id) {
        const job = pool.registry.get(params.task_id);
        if (!job) {
          return errorResult(`unknown task id: ${params.task_id}`, {
            jobId: params.task_id,
            reason: "unknown task id",
          });
        }
        const disposition = resumeDisposition(caller, job, (jobId) => pool.registry.get(jobId));
        if (disposition.kind === "reject") {
          return errorResult(`cannot resume task ${params.task_id}: ${disposition.reason}`, {
            jobId: params.task_id,
            reason: disposition.reason,
          });
        }
        if (disposition.kind === "steer") {
          const control = pool.liveChildren.get(job.jobId);
          if (!control) {
            return errorResult(`task ${params.task_id} is running but has no live child to steer`, {
              jobId: job.jobId,
              reason: "no live child",
            });
          }
          await control.steer(params.prompt);
          return textResult(`Steered running task ${job.jobId}.`, {
            jobId: job.jobId,
            status: "running",
          });
        }
        if (disposition.kind === "fresh-spawn") {
          return taskExecute(params, ctx, caller, { parentJobId: job.jobId });
        }
        // Resume from the stored transcript.
        if (!job.sessionFile) {
          return errorResult(`task ${params.task_id} has no stored transcript to resume`, {
            jobId: job.jobId,
            reason: "no stored transcript",
          });
        }
        const resumeJobId = makeJobId();
        let copyPath: string | undefined;
        try {
          copyPath = copySessionFile(job.sessionFile, resumeJobId, ctx.cwd);
        } catch {
          copyPath = undefined;
        }
        if (!copyPath) {
          return errorResult(`could not copy the transcript for task ${params.task_id}`, {
            jobId: job.jobId,
            reason: "transcript copy failed",
          });
        }
        return taskExecute(params, ctx, caller, {
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

        const job = recordNewJob(pool.registry, {
          jobId: makeJobId(),
          status: "queued",
          description: params.description,
          subagentType: params.subagent_type,
        });

        // The direct-parent session file keys result delivery. The realisation
        // below is async, so the job is acknowledged as `running` to match the
        // contract (return immediately with the job id and a running
        // acknowledgement); a gate slot is acquired before the child runs.
        pool.registry.updateJob(job.jobId, { status: "running" });

        const parentSessionFile = ctx.sessionManager.getSessionFile() ?? "";
        const parentSessionId = ctx.sessionManager.getSessionId();

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
          `Accepted background task ${job.jobId}. Its result will be delivered when it finishes.`,
          { jobId: job.jobId, status: job.status },
        );
      }

      return taskExecute(params, ctx, caller);
    },
  });
}

/**
 * Run a new or resumed job in the foreground and settle its registry record.
 *
 * Shared by fresh `task` calls and by the resume/fresh-spawn branches of
 * `task(task_id, prompt)`. `parentJobId`/`sessionFile` carry the resumed
 * lineage and transcript; a fresh call leaves both unset.
 */
async function taskExecute(
  params: TaskParams,
  ctx: ExtensionContext,
  caller: ControlCaller,
  options: { jobId?: string; parentJobId?: string; sessionFile?: string } = {},
): Promise<AgentToolResult<TaskDetails | TaskErrorDetails>> {
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
  // already cancelled by `task_cancel` mid-run, the status update is a legal
  // no-op, so persist the session file in a separate update.
  pool.registry.updateJob(job.jobId, { status: settleStatus(result.status) });
  pool.registry.updateJob(job.jobId, { sessionFile: result.sessionFile });

  if (result.status === "completed") {
    return textResult(`Task ${job.jobId} completed:\n${result.output}`, {
      jobId: job.jobId,
      status: "completed",
      result: result.output,
    });
  }
  return errorResult(
    result.status === "aborted"
      ? `task ${job.jobId} was aborted`
      : `task ${job.jobId} failed: ${result.output}`,
    { jobId: job.jobId, reason: result.status === "aborted" ? "aborted" : "failed" },
  );
}

function registerCancelTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "task_cancel",
    label: "Cancel task",
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
      const decision = canCancel(caller, job, (jobId) => pool.registry.get(jobId));
      if (!decision.allowed) {
        return textResult(`Task ${params.job_id} is not cancellable: ${decision.reason}.`, {
          jobId: params.job_id,
          success: false,
          status: job.status,
          allowed: false,
          reason: decision.reason,
        });
      }

      const control = pool.liveChildren.get(job.jobId);
      if (!control) {
        return textResult(`Task ${params.job_id} is running but has no live child to abort.`, {
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
      return textResult(`Task ${params.job_id} was cancelled.`, {
        jobId: params.job_id,
        success: true,
        status: "cancelled",
      });
    },
  });
}

function registerStatusTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "task_status",
    label: "Task status",
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
      const result = statusFor(caller, job, (jobId) => pool.registry.get(jobId));
      return textResult(`Task ${params.job_id} is ${job.status}.`, {
        status: job.status,
        job: toJobSummary(job),
        controllable: result.controllable,
      });
    },
  });
}

function registerJobsTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "task_jobs",
    label: "List tasks",
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

/** PI extension entry point. */
export default function piCodeExtension(pi: ExtensionAPI): void {
  registerTaskTool(pi);
  registerCancelTool(pi);
  registerStatusTool(pi);
  registerJobsTool(pi);
  registerLifecycleGates(pi);

  pi.on("turn_start", (_event: TurnStartEvent, ctx: ExtensionContext) => {
    // A turn is one model response and its tool batch. Resetting here means
    // separate responses get independent MAX_PARALLEL_TASKS budgets while the
    // pool still shares the counter across all task calls in this response.
    getChildPool(ctx.cwd).resetParallelTasks();
  });

  pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;

    const pool = getChildPool(ctx.cwd);
    if (event.reason === "fork" && event.previousSessionFile) {
      // Fork creates the descendant before this event. Pending results that
      // were addressed to the replaced parent must follow that descendant.
      pool.delivery.rebind(event.previousSessionFile, sessionFile);
    }
    pool.delivery.register(sessionFile, (content) => {
      // `followUp` queues behind the active run instead of interrupting a
      // streaming response. The SDK host owns the actual parent session.
      pi.sendUserMessage(content, { deliverAs: "followUp" });
    });
  });

  pi.on("session_shutdown", async (event: SessionShutdownEvent, ctx: ExtensionContext) => {
    const pool = getChildPool(ctx.cwd);
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) {
      pool.delivery.unregister(sessionFile);
    }
    // Child sessions also emit `quit` when they are disposed after settling.
    // Only the root orchestrator may sweep the project's shared jobs; a child
    // must never abort its siblings or its parent while it is being cleaned up.
    const isChildSession = pool.registry.get(ctx.sessionManager.getSessionId()) !== undefined;
    if (isChildSession) return;

    // Process quit and a confirmed `/new` both terminate the current host
    // session's background work. Reload/resume/fork preserve live children.
    if (event.reason === "quit" || event.reason === "new") {
      await pool.interruptRunningJobs();
    }
  });
}

/**
 * Ask the user to confirm `/new` when orchestrator background jobs are running.
 *
 * Called before the session switch. Returns `{ cancel: true }` to abort the
 * switch when the user declines, so running children are not orphaned without
 * consent. `/fork` is not gated: it keeps delivering results into the
 * descendant session and never kills children.
 */
async function confirmNewWithRunningJobs(
  _event: SessionBeforeSwitchEvent,
  ctx: ExtensionContext,
): Promise<{ cancel?: boolean }> {
  const pool = getChildPool(ctx.cwd);
  const running = Array.from(pool.registry.all().values()).filter((job) => job.status === "running");
  if (running.length === 0) return {};

  if (!ctx.hasUI) {
    return { cancel: true };
  }
  const confirmed = await ctx.ui.confirm(
    "Running background tasks",
    `${running.length} background task(s) are still running. Starting a new session will stop them. Continue?`,
  );
  return { cancel: !confirmed };
}

function registerLifecycleGates(pi: ExtensionAPI): void {
  pi.on("session_before_switch", async (event: SessionBeforeSwitchEvent, ctx: ExtensionContext) => {
    if (event.reason !== "new") return undefined;
    // The handler is awaited by the host before the switch and may cancel it by
    // returning `{ cancel: true }`.
    return confirmNewWithRunningJobs(event, ctx);
  });
}

export { extensionName };
export * from "./shared/constants.ts";
export * from "./shared/types.ts";