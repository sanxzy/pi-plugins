import type { Job } from "@xzy-ai/core";
import type { JobSummary } from "./types.ts";

/**
 * Public summary of a job, with no session handle or filesystem path.
 *
 * Domain entities are mapped to API-facing summaries at the shared host
 * boundary; nothing that leaks an implementation detail passes through.
 */
export function toJobSummary(job: Job): JobSummary {
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
