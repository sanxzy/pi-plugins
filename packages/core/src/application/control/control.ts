import type { Job } from "../../domain/jobs/job.ts";
import { isTerminal } from "../../domain/jobs/status.ts";

/**
 * Pure control-use-case helpers for job cancel, status, list, and resume/steer.
 *
 * These are the application-layer rules: what a caller is allowed to do to a
 * job, and how the surfaced result is shaped. All effects (aborting a child,
 * reopening a session file, steering) are delegated to the ports the caller
 * wires in; nothing here touches a session or the filesystem.
 */

/** A caller's view of a job, keyed by its own session id / job id. */
export interface ControlCaller {
  /** The caller's own job id (its child session id), if it is itself a job. */
  readonly jobId?: string;
  /** The caller's root job id, if its lineage is known. */
  readonly rootJobId?: string;
}

/** Why a control action was rejected. */
export type RejectReason =
  | "unknown job id"
  | "not a descendant"
  | "already terminal"
  | "not running"
  | "no live child"
  | "not controllable";

/** Outcome of a lineage-scope check. */
export type ScopeCheck =
  | { allowed: true }
  | { allowed: false; reason: "unknown job id" | "not a descendant" };

/**
 * Whether the caller may control the target job.
 *
 * A caller may control only jobs in its own descendant lineage. The check is
 * rooted at the caller's own job id: the target must be reached by walking the
 * target's parent chain up to the caller. Sibling and ancestor jobs are never
 * controllable.
 */
export function checkControlScope(
  caller: ControlCaller,
  target: Job,
  getJob: (jobId: string) => Job | undefined,
): ScopeCheck {
  if (!caller.jobId) {
    // The root orchestrator has no job id of its own; it may control every job
    // in the project registry.
    return { allowed: true };
  }
  if (target.jobId === caller.jobId) {
    // A job may not cancel or resume itself.
    return { allowed: false, reason: "not a descendant" };
  }
  // Walk from the target upward: the caller must appear in the target's parent
  // chain for the target to be a descendant of the caller.
  let current: Job | undefined = target;
  while (current?.parentJobId !== undefined) {
    if (current.parentJobId === caller.jobId) return { allowed: true };
    current = getJob(current.parentJobId);
  }
  return { allowed: false, reason: "not a descendant" };
}

/** Visibility includes the caller's own job, while control remains strict. */
function isVisibleToCaller(caller: ControlCaller, target: Job, getJob: (jobId: string) => Job | undefined): boolean {
  if (!caller.jobId) return true;
  if (target.jobId === caller.jobId) return true;
  return checkControlScope(caller, target, getJob).allowed;
}

/** Whether a job may be cancelled: running, in scope, and not already terminal. */
export function canCancel(
  caller: ControlCaller,
  target: Job,
  getJob: (jobId: string) => Job | undefined,
): { allowed: boolean; reason?: RejectReason } {
  const scope = checkControlScope(caller, target, getJob);
  if (!scope.allowed) return { allowed: false, reason: scope.reason };
  if (isTerminal(target.status)) return { allowed: false, reason: "already terminal" };
  if (target.status !== "running") return { allowed: false, reason: "not running" };
  return { allowed: true };
}

/** Result of a status lookup. */
export interface StatusResult {
  readonly job: Job;
  /** The caller may read this job's status even when it cannot control it. */
  readonly controllable: boolean;
}

/** Look up a job for `agent_status`, tolerating unknown ids. */
export function statusFor(caller: ControlCaller, job: Job, getJob: (jobId: string) => Job | undefined): StatusResult {
  return { job, controllable: isVisibleToCaller(caller, job, getJob) };
}

/** The jobs visible to a caller: its own descendant lineage plus, at root, everything. */
export function visibleJobs(caller: ControlCaller, jobs: Iterable<Job>, getJob: (jobId: string) => Job | undefined): Job[] {
  return Array.from(jobs).filter((job) => isVisibleToCaller(caller, job, getJob));
}

/** Outcome of a resume/steer admission check. */
export type ResumeDisposition =
  | { kind: "steer"; job: Job }
  | { kind: "resume"; job: Job }
  | { kind: "fresh-spawn"; job: Job }
  | { kind: "reject"; reason: RejectReason; job: Job };

/**
 * Decide what `agent(agent_id, prompt)` should do with an existing job.
 *
 * - A running job is steered: the live child gets the new prompt and the call
 *   returns immediately without creating a duplicate job.
 * - A completed, cancelled, or interrupted job is resumed from its stored
 *   session file.
 * - A `created` job has no transcript yet (the child never produced a first
 *   assistant message), so it is re-spawned fresh with the same prompt.
 *   Re-spawning is non-destructive: the original job record is left untouched.
 * - A queued job follows the resume path, allowing the composition root to
 *   reopen a transcript if one has already been persisted.
 * - Anything outside the caller's lineage is rejected.
 */
export function resumeDisposition(
  caller: ControlCaller,
  job: Job,
  getJob: (jobId: string) => Job | undefined,
): ResumeDisposition {
  const scope = checkControlScope(caller, job, getJob);
  if (!scope.allowed) return { kind: "reject", reason: scope.reason, job };
  if (job.status === "running") return { kind: "steer", job };
  if (job.status === "created") return { kind: "fresh-spawn", job };
  if (isTerminal(job.status) || job.status === "queued") return { kind: "resume", job };
  return { kind: "reject", reason: "not running", job };
}