import type { Job, JobUpdate } from "@xzy-ai/core";
import type { ChildRunResult } from "@xzy-ai/core";
import { AGENT_OPERATIONS, processWithLog } from "@xzy-ai/observability";
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

/**
 * Reason a root-host background request is invalid in the given extension mode.
 *
 * Child and descendant calls never use this path: they run foreground and await
 * their descendant directly, including when the SDK session mode is `print`.
 */
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
  /** Compatibility seam for isolated lifecycle tests; production uses the registry. */
  manifest?: AgentManifestStore;
}

interface RunBackgroundJobOptions {
  parentSessionFile: string;
  runChild: () => Promise<ChildRunResult | undefined>;
  /**
   * Called when the child run fails (thrown error or failed result) with the
   * surfaced message. The agent tool uses this to notify the user through
   * `ctx.ui.notify` so configuration errors (e.g. an unresolvable global or
   * frontmatter model) are visible immediately for manual correction.
   */
  onChildFailed?: (message: string) => void;
}

/**
 * Run a background child to completion and deliver its result to the direct
 * parent. The registry transition is recorded before delivery so the job is
 * always terminal once the parent reads it back.
 */
export function runBackgroundJob(
  deps: BackgroundJobDeps,
  job: Job,
  options: RunBackgroundJobOptions,
): Promise<void> {
  return processWithLog({ operation: AGENT_OPERATIONS.RUN_BACKGROUND, parameters: { jobId: job.jobId, subagentType: job.subagentType } }, async () => {
    await runBackgroundJobInner(deps, job, options);
  });
}

async function runBackgroundJobInner(
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
    options.onChildFailed?.(message);
    const delivered = deps.delivery.deliverResult(job.jobId, options.parentSessionFile, formatBackgroundResult(job.subagentType, job.jobId, {
      sessionFile: "",
      output: message,
      status: "failed",
    }), { subagentType: job.subagentType, jobId: job.jobId });
    if (delivered) deps.registry.updateJob(job.jobId, { delivered: true });
    return;
  }

  if (!result) {
    deps.registry.updateJob(job.jobId, { status: "failed" });
    options.onChildFailed?.("could not spawn child");
    const delivered = deps.delivery.deliverResult(job.jobId, options.parentSessionFile, formatBackgroundResult(job.subagentType, job.jobId, {
      sessionFile: "",
      output: "could not spawn child",
      status: "failed",
    }), { subagentType: job.subagentType, jobId: job.jobId });
    if (delivered) deps.registry.updateJob(job.jobId, { delivered: true });
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
  if (result.status === "failed" && result.output !== "(no output)" && result.output.trim() !== "") options.onChildFailed?.(result.output);
  // Delivery owns the delivered flag: it is set immediately only when the
  // parent sink accepts the result, or later when a durable pending result is
  // drained after the parent session registers again.
  const delivered = deps.delivery.deliverResult(job.jobId, options.parentSessionFile, formatBackgroundResult(job.subagentType, job.jobId, result), { subagentType: job.subagentType, jobId: job.jobId });
  if (delivered) deps.registry.updateJob(job.jobId, { delivered: true });
}
