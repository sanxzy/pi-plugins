/**
 * Structured `details` payloads returned by the four pi-code tools.
 *
 * These types stay at the shared host boundary and are intentionally kept free
 * of PI SDK session handles and raw filesystem paths.
 */

/** Current lifecycle status of a job, mirroring the domain status union. */
export type JobStatus =
  | "created"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/** Public summary of a single job, as exposed to the model. */
export interface JobSummary {
  jobId: string;
  status: JobStatus;
  description: string;
  subagentType: string;
  parentJobId?: string;
  rootJobId: string;
  depth: number;
  createdAt: string;
  updatedAt: string;
}

/** Details payload for the `task` tool. */
export interface TaskDetails {
  jobId: string;
  status: JobStatus;
  result?: string;
}

/** Edge-case outcome from the `task` tool. */
export interface TaskErrorDetails {
  jobId?: string;
  reason: string;
}

/** Details payload for the `task_status` tool. */
export interface StatusDetails {
  status: JobStatus;
  job?: JobSummary;
  reason?: string;
}

/** Details payload for the `task_jobs` tool. */
export interface JobsDetails {
  jobs: JobSummary[];
}

/** Details payload for the `task_cancel` tool. */
export interface CancelDetails {
  jobId: string;
  success: boolean;
  status?: JobStatus;
  reason?: string;
  allowed?: boolean;
}