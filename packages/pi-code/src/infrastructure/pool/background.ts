import type { Job, JobUpdate } from "../../domain/jobs/job.ts";
import type { ChildRunResult } from "../../domain/ports/child-session.ts";
import type { DeliveryCoordinator } from "./delivery.ts";

/**
 * Background task execution.
 *
 * A background task acknowledges immediately with the job id and runs the child
 * off the main turn. When the child settles, its result is delivered to the
 * direct parent session through the delivery coordinator, which either sends it
 * right away or defers it until the parent session re-registers. Delivery uses
 * `followUp` semantics at the host boundary (after the current run finishes, so
 * it never interrupts streaming).
 */

/** Reason a background request is invalid in the given extension mode. */
export function backgroundModeError(mode: string): string | undefined {
  if (mode === "tui") return undefined;
  return `background mode is invalid in ${mode} mode`;
}

/** Format a child result for the direct parent. */
export function formatBackgroundResult(jobId: string, result: ChildRunResult): string {
  if (result.status === "completed") {
    return `Background task ${jobId} completed:\n${result.output}`;
  }
  if (result.status === "aborted") {
    return `Background task ${jobId} was aborted.`;
  }
  return `Background task ${jobId} failed: ${result.output}`;
}

interface BackgroundJobDeps {
  registry: {
    updateJob(jobId: string, update: JobUpdate): void;
  };
  delivery: DeliveryCoordinator;
}

interface RunBackgroundJobOptions {
  parentSessionFile: string;
  runChild: () => Promise<ChildRunResult | undefined>;
}

/**
 * Run a background child to completion and deliver its result to the direct
 * parent. The registry transition is recorded before delivery so the job is
 * always terminal once the parent reads it back.
 */
export async function runBackgroundJob(
  deps: BackgroundJobDeps,
  job: Job,
  options: RunBackgroundJobOptions,
): Promise<void> {
  let result: ChildRunResult | undefined;
  try {
    result = await options.runChild();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.registry.updateJob(job.jobId, { status: "failed" });
    deps.delivery.deliverResult(job.jobId, options.parentSessionFile, formatBackgroundResult(job.jobId, {
      sessionFile: "",
      output: message,
      status: "failed",
    }));
    deps.registry.updateJob(job.jobId, { delivered: true });
    return;
  }

  if (!result) {
    deps.registry.updateJob(job.jobId, { status: "failed" });
    deps.delivery.deliverResult(job.jobId, options.parentSessionFile, formatBackgroundResult(job.jobId, {
      sessionFile: "",
      output: "could not spawn child",
      status: "failed",
    }));
    deps.registry.updateJob(job.jobId, { delivered: true });
    return;
  }

  // Mark the job terminal and persist the child's transcript. If the job was
  // already cancelled by `task_cancel` mid-run, the status update is a legal
  // no-op, so persist the session file in a separate update.
  deps.registry.updateJob(job.jobId, {
    status: result.status === "completed" ? "completed" : result.status === "aborted" ? "cancelled" : "failed",
  });
  deps.registry.updateJob(job.jobId, { sessionFile: result.sessionFile });
  deps.delivery.deliverResult(job.jobId, options.parentSessionFile, formatBackgroundResult(job.jobId, result));
  deps.registry.updateJob(job.jobId, { delivered: true });
}