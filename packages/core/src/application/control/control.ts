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
  /** The live session id whose descendant tree this caller owns. */
  readonly sessionId: string;
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
 * Whether the target job belongs to the caller's live session tree.
 *
 * A parent session sees the jobs whose lineage is rooted at that exact live
 * session id, including historical terminal records. A nested caller retains
 * its own job plus its recursive descendants, never its siblings or ancestors.
 * The session boundary is applied before lineage control: a job owned by
 * another parent session is indistinguishable from an unknown job.
 */
export function isInSessionScope(caller: ControlCaller, target: Job, getJob: (jobId: string) => Job | undefined): boolean {
  const sessionId = caller.sessionId;
  if (target.jobId === caller.jobId && caller.jobId !== undefined) return true;
  if (target.parentSessionId === sessionId) return true;
  if (target.parentJobId === undefined) return false;
  // Walk the target's parent chain upward: the caller's session must be the
  // session that rooted this lineage. The immediate parent session is the
  // session that spawned the job, so the root ancestor's parent session id is
  // the live parent session that owns the tree.
  let current: Job | undefined = target;
  while (current?.parentJobId !== undefined) {
    const parent = getJob(current.parentJobId);
    if (!parent) return false;
    if (parent.parentSessionId === sessionId) return true;
    current = parent;
  }
  return false;
}

/**
 * Whether the caller may control the target job.
 *
 * A caller may control only jobs in its own descendant lineage. The check is
 * rooted at the caller's own job id: the target must be reached by walking the
 * target's parent chain up to the caller. Sibling and ancestor jobs are never
 * controllable. The caller's own live session tree is the outer boundary.
 */
export function checkControlScope(
  caller: ControlCaller,
  target: Job,
  getJob: (jobId: string) => Job | undefined,
): ScopeCheck {
  if (!isInSessionScope(caller, target, getJob)) return { allowed: false, reason: "not a descendant" };
  if (!caller.jobId) {
    // The root orchestrator has no job id of its own; it may control every job
    // in its own live session tree.
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
  if (!isInSessionScope(caller, target, getJob)) return false;
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

/**
 * The jobs listed to a caller: only jobs spawned directly by that caller.
 *
 * This intentionally differs from `isVisibleToCaller`, which remains
 * recursive for status, cancellation, and resume/steer operations. Listing a
 * caller's direct children keeps each parent's history bounded to its own
 * 25-job retention window and prevents grandchildren from leaking upward.
 */
export function visibleJobs(caller: ControlCaller, jobs: Iterable<Job>, _getJob: (jobId: string) => Job | undefined): Job[] {
  return Array.from(jobs).filter((job) =>
    caller.jobId === undefined
      ? job.parentSessionId === caller.sessionId && job.parentJobId === undefined
      : job.parentJobId === caller.jobId,
  );
}

/** Outcome of a resume/steer admission check. */
export type ResumeDisposition =
  | { kind: "steer"; job: Job }
  | { kind: "resume"; job: Job }
  | { kind: "reject"; reason: RejectReason; job: Job };

/**
 * Decide what `agent(agent_id, prompt)` should do with an existing job.
 *
 * - A running job is steered: the live child gets the new prompt and the call
 *   returns immediately without creating a duplicate job.
 * - A completed, failed, cancelled, interrupted, or queued job is resumed in
 *   place from its stored session file. The job id and transcript remain
 *   stable, so no duplicate record or copied transcript is created.
 * - A `created` job has no transcript yet; it is rejected because there is no
 *   existing agent context to resume.
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
  if (job.status === "created") return { kind: "reject", reason: "not running", job };
  if (isTerminal(job.status) || job.status === "queued") return { kind: "resume", job };
  return { kind: "reject", reason: "not running", job };
}