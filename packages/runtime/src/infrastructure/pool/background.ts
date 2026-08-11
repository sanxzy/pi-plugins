import type { Job, JobUpdate } from "@xzy-ai/core";
import type { ChildRunResult } from "@xzy-ai/core";
import type { DeliveryCoordinator } from "./delivery.ts";
import type { AgentManifestStore } from "../manifests/manifests.ts";

/**
 * Background agent execution.
 *
 * A background agent call acknowledges immediately with the job id and runs the
 * child off the main turn. When the child settles, its result is delivered to
 * the direct parent session through the delivery coordinator, which either
 * sends it right away or defers it until the parent session re-registers.
 * Delivery uses `steer` semantics at the host boundary so the parent receives
 * the result immediately.
 */

/** Reason a background request is invalid in the given extension mode. */
export function backgroundModeError(mode: string): string | undefined {
  if (mode === "tui") return undefined;
  return `background mode is invalid in ${mode} mode`;
}

/** Format a child result for the direct parent. */
export function formatBackgroundResult(subagentType: string, jobId: string, result: ChildRunResult): string {
  if (result.status === "completed") {
    return `Background agent ${subagentType} (${jobId}) completed:\n${result.output}`;
  }
  if (result.status === "aborted") {
    return `Background agent ${subagentType} (${jobId}) was aborted.`;
  }
  return `Background agent ${subagentType} (${jobId}) failed: ${result.output}`;
}

interface BackgroundJobDeps {
  registry: {
    updateJob(jobId: string, update: JobUpdate): void;
  };
  delivery: DeliveryCoordinator;
  manifest?: AgentManifestStore;
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
    deps.manifest?.update({ status: "failed", endedAt: new Date().toISOString() });
    deps.delivery.deliverResult(job.jobId, options.parentSessionFile, formatBackgroundResult(job.subagentType, job.jobId, {
      sessionFile: "",
      output: message,
      status: "failed",
    }));
    deps.registry.updateJob(job.jobId, { delivered: true });
    deps.manifest?.update({ status: "failed", delivered: true });
    return;
  }

  if (!result) {
    deps.registry.updateJob(job.jobId, { status: "failed" });
    deps.manifest?.update({ status: "failed", endedAt: new Date().toISOString() });
    deps.delivery.deliverResult(job.jobId, options.parentSessionFile, formatBackgroundResult(job.subagentType, job.jobId, {
      sessionFile: "",
      output: "could not spawn child",
      status: "failed",
    }));
    deps.registry.updateJob(job.jobId, { delivered: true });
    deps.manifest?.update({ status: "failed", delivered: true });
    return;
  }

  // Mark the job terminal and persist the child's transcript. If the job was
  // already cancelled by `agent_cancel` mid-run, the registry update is a
  // legal no-op, so persist the session file separately.
  const terminalStatus = result.status === "completed" ? "completed" : result.status === "aborted" ? "cancelled" : "failed";
  const endedAt = new Date().toISOString();
  deps.registry.updateJob(job.jobId, { status: terminalStatus });
  deps.manifest?.update({ status: terminalStatus, endedAt, sessionFile: result.sessionFile });
  deps.registry.updateJob(job.jobId, { sessionFile: result.sessionFile });
  deps.delivery.deliverResult(job.jobId, options.parentSessionFile, formatBackgroundResult(job.subagentType, job.jobId, result));
  deps.registry.updateJob(job.jobId, { delivered: true });
  deps.manifest?.update({ status: terminalStatus, delivered: true });
}
