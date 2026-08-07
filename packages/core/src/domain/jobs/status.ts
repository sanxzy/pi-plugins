/**
 * Job lifecycle status as a discriminated union.
 *
 * The union makes invalid states unrepresentable: a job is always in exactly
 * one of these seven states, and the legal transitions below define the only
 * allowed moves between them.
 */

export type JobStatus =
  | "created"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/** Terminal statuses: once reached, a job does not move again. */
export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/** Legal transitions between job statuses. */
export const STATUS_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  created: ["queued", "running", "cancelled", "interrupted"],
  queued: ["running", "cancelled", "interrupted"],
  running: ["completed", "failed", "cancelled", "interrupted"],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

/** Whether a status is terminal (no further transitions allowed). */
export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Whether a transition from `from` to `to` is legal. */
export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}
