import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isDefaultAgentName } from "./domain/agents/default-agent.ts";
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

      if (params.background) {
        return textResult(
          `Accepted background task ${job.jobId}. Execution will be connected in a later phase.`,
          { jobId: job.jobId, status: job.status },
        );
      }

      // Foreground: run the child synchronously and return its final output.
      // The child inherits the parent's model; without one there is nothing to run.
      if (!ctx.model) {
        pool.registry.updateJob(job.jobId, { status: "failed" });
        return errorResult("no model available to run the child session", {
          jobId: job.jobId,
          reason: "no model available",
        });
      }

      // Unknown subagent types are rejected before any child is created.
      if (!isDefaultAgentName(params.subagent_type)) {
        pool.registry.updateJob(job.jobId, { status: "failed" });
        return errorResult(
          `unknown subagent_type: ${params.subagent_type}`,
          { jobId: job.jobId, reason: "unknown subagent_type" },
        );
      }

      pool.registry.updateJob(job.jobId, { status: "running" });
      const result = await spawnChildSession({
        jobId: job.jobId,
        cwd: ctx.cwd,
        subagentType: params.subagent_type,
        prompt: params.prompt,
        parentSessionId: ctx.sessionManager.getSessionId(),
        model: ctx.model,
        signal: ctx.signal,
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
