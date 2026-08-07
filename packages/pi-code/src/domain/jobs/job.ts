import type { JobStatus } from "./status.ts";

/**
 * Immutable job record.
 *
 * A job is created once with its identity and lineage, then updated by
 * producing a new value — never mutated in place. The registry persists a
 * sequence of events and folds them back into the current job state on read,
 * so this record is always derived from the event log.
 */
export interface Job {
  /** Stable identity, assigned by the orchestrator. */
  readonly jobId: string;
  /** Current status. */
  readonly status: JobStatus;
  /** Short description of the delegated work. */
  readonly description: string;
  /** Name of the agent definition that runs this job. */
  readonly subagentType: string;
  /** Id of the job that spawned this one, if any. */
  readonly parentJobId?: string;
  /** Id of the root job in this lineage. */
  readonly rootJobId: string;
  /** Depth in the lineage (root = 0). */
  readonly depth: number;
  /** Exact session file path returned by the child session manager, if known. */
  readonly sessionFile?: string;
  /** Token/usage accounting, populated when the child completes. */
  readonly usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens: number;
    turns: number;
  };
  /** Whether the completed result has been delivered to the direct parent. */
  readonly delivered: boolean;
  /** Creation timestamp (ISO 8601). */
  readonly createdAt: string;
  /** Last transition timestamp (ISO 8601). */
  readonly updatedAt: string;
}

/** Fields required to create a new job. */
export interface NewJobInput {
  jobId: string;
  status: JobStatus;
  description: string;
  subagentType: string;
  parentJobId?: string;
  rootJobId?: string;
  depth?: number;
  sessionFile?: string;
  createdAt?: string;
}

/**
 * Create a new job.
 *
 * Lineage defaults to the job being its own root at depth 0 when no parent is
 * supplied. A parent job always roots at the parent's root and sits one level
 * deeper than the parent.
 */
export function createJob(input: NewJobInput): Job {
  const now = input.createdAt ?? new Date().toISOString();
  const parentJobId = input.parentJobId;
  const rootJobId = input.rootJobId ?? input.jobId;
  const depth = input.depth ?? (parentJobId === undefined ? 0 : 1);
  return {
    jobId: input.jobId,
    status: input.status,
    description: input.description,
    subagentType: input.subagentType,
    parentJobId,
    rootJobId,
    depth,
    sessionFile: input.sessionFile,
    usage: undefined,
    delivered: false,
    createdAt: now,
    updatedAt: now,
  };
}

/** Fields that may change on an existing job. */
export interface JobUpdate {
  status?: JobStatus;
  sessionFile?: string;
  usage?: Job["usage"];
  delivered?: boolean;
  updatedAt?: string;
}

/** Produce a new job value with the given updates applied. */
export function updateJob(job: Job, update: JobUpdate): Job {
  return {
    ...job,
    ...update,
    usage: update.usage === undefined ? job.usage : update.usage,
    updatedAt: update.updatedAt === undefined ? new Date().toISOString() : update.updatedAt,
  };
}

/** Whether a job id is a descendant of the given root lineage. */
export function isDescendantOf(job: Job, rootJobId: string): boolean {
  return job.rootJobId === rootJobId;
}

/**
 * Whether `ancestorJob` is a strict ancestor of `job` in the job lineage.
 *
 * The check walks the parent chain from `job` upward, so a sibling (same root,
 * different parent) is never treated as an ancestor. A job is not its own
 * ancestor.
 */
export function isJobAncestorOf(ancestorJob: Job, job: Job, getJob: (jobId: string) => Job | undefined): boolean {
  let parentJobId = job.parentJobId;
  while (parentJobId !== undefined) {
    if (parentJobId === ancestorJob.jobId) return true;
    const parent = getJob(parentJobId);
    if (!parent) return false;
    parentJobId = parent.parentJobId;
  }
  return false;
}
