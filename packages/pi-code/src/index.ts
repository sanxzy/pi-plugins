import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getChildPool } from "./infrastructure/pool/child-pool.ts";
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
      if (params.background && ctx.mode !== "tui") {
        return errorResult(
          "background tasks are available only in TUI mode",
          { jobId: undefined, reason: `background mode is invalid in ${ctx.mode} mode` },
        );
      }

      const pool = getChildPool(ctx.cwd);

      // A model-supplied id is never used to create or address a job. It must
      // resolve to an exact existing job, otherwise it is rejected.
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

      const job = recordNewJob(pool.registry, {
        jobId: makeJobId(),
        status: params.background ? "queued" : "created",
        description: params.description,
        subagentType: params.subagent_type,
      });

      return textResult(
        params.background
          ? `Accepted background task ${job.jobId}. Execution will be connected in a later phase.`
          : `Accepted task ${job.jobId}. Foreground execution will be connected in a later phase.`,
        { jobId: job.jobId, status: job.status },
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

  pi.on("session_start", () => {
    // The pool is initialized lazily by the first tool call. This event keeps
    // extension startup side-effect free while reserving the lifecycle seam.
  });

  pi.on("session_shutdown", () => {
    // Shutdown interruption is implemented in Phase 7.
  });
}

export { extensionName };
export * from "./shared/constants.ts";
export * from "./shared/types.ts";
