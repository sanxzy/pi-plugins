import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseJobEvent, serializeJobEvent, type JobEvent } from "@xzy-ai/core";
import { createJob, updateJob, type Job, type JobUpdate } from "@xzy-ai/core";
import { canTransition } from "@xzy-ai/core";

/**
 * Append-only job registry.
 *
 * The registry is the single writer of job events. Each event is appended to a
 * JSONL file; readers fold the log into the current job state. The log is never
 * rewritten, so a reader can always reconstruct state up to the last appended
 * event even if a crash truncated the tail.
 *
 * The registry is owned by the shared per-project pool, so it is safe to create
 * at most one instance per project root.
 */
export interface Registry {
  readonly filePath: string;
  /** Append a job event and update the in-memory index. */
  append(event: JobEvent): void;
  /** Record creation of a fresh job. */
  createJob(job: Job): void;
  /** Record a legal update to an existing job; ignore unknown or illegal updates. */
  updateJob(jobId: string, update: JobUpdate): void;
  /** Fold the log into the current job state. */
  fold(): Map<string, Job>;
  /** Look up a single job by id after folding. */
  get(jobId: string): Job | undefined;
  /** All jobs, keyed by id. */
  all(): Map<string, Job>;
}

export function createRegistry(filePath: string): Registry {
  let index = new Map<string, Job>();

  // Rehydrate from any existing log so the pool and the on-disk state agree.
  if (existsSync(filePath)) {
    index = foldLog(filePath);
  }

  const append = (event: JobEvent): void => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${serializeJobEvent(event)}\n`, { flag: "a" });
  };

  return {
    filePath,
    append,
    createJob(job: Job): void {
      append({ type: "created", job, at: job.createdAt });
      index.set(job.jobId, job);
    },
    updateJob(jobId: string, update: JobUpdate): void {
      const current = index.get(jobId);
      if (!current) return;
      const to = update.status;
      if (to !== undefined && !canTransition(current.status, to)) return;
      const next = updateJob(current, update);
      append({ type: "updated", jobId, update, at: next.updatedAt });
      index.set(jobId, next);
    },
    fold(): Map<string, Job> {
      index = foldLog(filePath);
      return index;
    },
    get(jobId: string): Job | undefined {
      return index.get(jobId);
    },
    all(): Map<string, Job> {
      return index;
    },
  };
}

/** Fold a JSONL log into the current job state. */
export function foldLog(filePath: string): Map<string, Job> {
  const result = new Map<string, Job>();
  if (!existsSync(filePath)) return result;

  const lines = readFileSync(filePath, "utf-8").split("\n");
  for (const line of lines) {
    const event = parseJobEvent(line);
    if (!event) continue;
    if (event.type === "created") {
      result.set(event.job.jobId, event.job);
    } else if (event.type === "updated") {
      // Replay the exact transition timestamp recorded at append time so a fold
      // deterministically reconstructs the appended state. Updates that would
      // violate the legal transition table are skipped, matching the writer.
      const current = result.get(event.jobId);
      if (!current) continue;
      const to = event.update.status;
      if (to !== undefined && !canTransition(current.status, to)) continue;
      result.set(event.jobId, updateJob(current, { ...event.update, updatedAt: event.at }));
    }
  }
  return result;
}

/** Convenience: create a job value and record it in the registry. */
export function recordNewJob(registry: Registry, input: {
  jobId: string;
  status: Job["status"];
  description: string;
  subagentType: string;
  parentJobId?: string;
  rootJobId?: string;
  depth?: number;
  sessionFile?: string;
}): Job {
  const job = createJob(input);
  registry.createJob(job);
  return job;
}

export { createJob, updateJob };
export type { Job };
