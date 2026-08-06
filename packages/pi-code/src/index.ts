import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { isDefaultAgentName } from "./domain/agents/default-agent.ts";
import { backgroundModeError, runBackgroundJob } from "./infrastructure/pool/background.ts";
import { getChildPool } from "./infrastructure/pool/child-pool.ts";
import { spawnChildSession } from "./infrastructure/pi-sdk/child-session.ts";
import { recordNewJob } from "./infrastructure/registry/registry.ts";
import type { Job } from "./domain/jobs/job.ts";
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

      // A model-supplied id is never used to create or address a job. It must
      // resolve to an exact existing job, otherwise it is rejected. The counter
      // above is not consumed by a resume/steer: it only addresses an existing
      // job and does not spawn a new child.
      if (params.task_id) {
        if (!pool.registry.get(params.task_id)) {
          return errorResult(`unknown task id: ${params.task_id}`, {
            jobId: params.task_id,
            reason: "unknown task id",
          });
        }
        return textResult(`Task ${params.task_id} already exists; execution will be connected in a later phase.`, {
          jobId: params.task_id,
          status: pool.registry.get(params.task_id)!.status,
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
        if (!isDefaultAgentName(params.subagent_type)) {
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
              spawnChildSession({
                jobId: job.jobId,
                cwd: ctx.cwd,
                subagentType: params.subagent_type,
                prompt: params.prompt,
                parentSessionId,
                model: ctx.model,
                signal: undefined,
                run: (operation) =>
                  pool.concurrency.run(() => {
                    pool.registry.updateJob(job.jobId, { status: "running" });
                    return operation();
                  }),
              }),
          },
        );

        return textResult(
          `Accepted background task ${job.jobId}. Its result will be delivered when it finishes.`,
          { jobId: job.jobId, status: job.status },
        );
      }

      // Foreground: validate before creating a queued record. The lifecycle
      // deliberately has no queued → failed transition; setup failures after
      // gate admission are recorded as running → failed instead.
      if (!ctx.model) {
        return errorResult("no model available to run the child session", {
          jobId: undefined,
          reason: "no model available",
        });
      }
      if (!isDefaultAgentName(params.subagent_type)) {
        return errorResult(
          `unknown subagent_type: ${params.subagent_type}`,
          { jobId: undefined, reason: "unknown subagent_type" },
        );
      }

      // Every foreground task starts queued and waits for a concurrency slot.
      // The `queued → running` transition happens at the moment the slot is acquired.
      const job = recordNewJob(pool.registry, {
        jobId: makeJobId(),
        status: "queued",
        description: params.description,
        subagentType: params.subagent_type,
      });

      // The child run is admitted through the shared concurrency gate. The
      // `queued → running` transition is recorded at the exact moment the slot is
      // acquired, so a job waiting for a slot stays observable as `queued`.
      const result = await spawnChildSession({
        jobId: job.jobId,
        cwd: ctx.cwd,
        subagentType: params.subagent_type,
        prompt: params.prompt,
        parentSessionId: ctx.sessionManager.getSessionId(),
        model: ctx.model,
        signal: ctx.signal,
        run: (operation) =>
          pool.concurrency.run(() => {
            pool.registry.updateJob(job.jobId, { status: "running" });
            return operation();
          }),
      });

      if (!result) {
        pool.registry.updateJob(job.jobId, { status: "failed" });
        return errorResult(`could not spawn child for ${params.subagent_type}`, {
          jobId: job.jobId,
          reason: "spawn failed",
        });
      }

      pool.registry.updateJob(job.jobId, {
        status: result.status === "completed" ? "completed" : result.status === "aborted" ? "cancelled" : "failed",
        sessionFile: result.sessionFile,
      });

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
    },
  });
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
      const job = getChildPool(ctx.cwd).registry.get(params.job_id);
      if (!job) {
        return errorResult(`unknown job id: ${params.job_id}`, {
          jobId: params.job_id,
          success: false,
          reason: "unknown job id",
        });
      }
      return textResult(`Task ${params.job_id} is not cancellable until execution is connected.`, {
        jobId: params.job_id,
        success: false,
        status: job.status,
        allowed: false,
        reason: "execution is not connected in the scaffold phase",
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
      const job = getChildPool(ctx.cwd).registry.get(params.job_id);
      if (!job) {
        return errorResult(`unknown job id: ${params.job_id}`, {
          status: "failed",
          reason: "unknown job id",
        });
      }
      return textResult(`Task ${params.job_id} is ${job.status}.`, {
        status: job.status,
        job: toJobSummary(job),
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
      const jobs = Array.from(getChildPool(ctx.cwd).registry.all().values()).map(toJobSummary);
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

  pi.on("turn_start", (_event: TurnStartEvent, ctx: ExtensionContext) => {
    // A turn is one model response and its tool batch. Resetting here means
    // separate responses get independent MAX_PARALLEL_TASKS budgets while the
    // pool still shares the counter across all task calls in this response.
    getChildPool(ctx.cwd).resetParallelTasks();
  });

  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;

    const pool = getChildPool(ctx.cwd);
    pool.delivery.register(sessionFile, (content) => {
      // `followUp` queues behind the active run instead of interrupting a
      // streaming response. The SDK host owns the actual parent session.
      pi.sendUserMessage(content, { deliverAs: "followUp" });
    });
  });

  pi.on("session_shutdown", (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) {
      getChildPool(ctx.cwd).delivery.unregister(sessionFile);
    }
    // Process-quit interruption is implemented in Phase 7.
  });
}

export { extensionName };
export * from "./shared/constants.ts";
export * from "./shared/types.ts";