import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseJobEvent, serializeJobEvent, type JobEvent } from "@xzy-ai/core";
import { createJob, updateJob, type Job, type JobUpdate } from "@xzy-ai/core";
import { canTransition, isTerminal } from "@xzy-ai/core";

/** Maximum number of terminal (settled) jobs retained per per-parent registry. */
export const MAX_RETAINED_TERMINAL_JOBS = 25;

/**
 * Append-only job registry.
 *
 * The registry is the single writer of job events. Each event is appended to a
 * JSONL file; readers fold the log into the current job state. The log is
 * appended to normally, and rewritten only when history must be pruned to keep
 * the file bounded. A reader always reconstructs state up to the last appended
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
  /**
   * Prune terminal jobs beyond the per-registry cap, oldest first. Non-terminal
   * jobs and ancestors of retained jobs are always preserved.
   */
  prune(): void;
}

/** Fold a JSONL log into a map of current job state. */
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

/** Rewrite the log, keeping only events for jobs in `keepJobIds`. */
function rewriteLog(filePath: string, keepJobIds: ReadonlySet<string>): void {
  if (!existsSync(filePath)) return;
  const keptEvents: JobEvent[] = [];
  for (const line of readFileSync(filePath, "utf-8").split("\n")) {
    const event = parseJobEvent(line);
    if (!event) continue;
    const jobId = event.type === "created" ? event.job.jobId : event.jobId;
    if (keepJobIds.has(jobId)) keptEvents.push(event);
  }
  // Write to a temp sibling and rename so readers never observe a partially
  // pruned log.
  const tmpPath = `${filePath}.tmp`;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(tmpPath, keptEvents.map(serializeJobEvent).join("\n") + (keptEvents.length > 0 ? "\n" : ""));
  renameSync(tmpPath, filePath);
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

  /** Collect ancestor job ids of the given job, walking the parent chain. */
  const ancestorsOf = (job: Job): Set<string> => {
    const ids = new Set<string>();
    let parentJobId = job.parentJobId;
    while (parentJobId !== undefined) {
      ids.add(parentJobId);
      const parent = index.get(parentJobId);
      if (!parent) return ids;
      parentJobId = parent.parentJobId;
    }
    return ids;
  };

  const prune = (): void => {
    const jobs = foldLog(filePath);
    const terminal = [...jobs.values()].filter((job) => isTerminal(job.status));
    if (terminal.length <= MAX_RETAINED_TERMINAL_JOBS) return;

    // Keep the newest terminal jobs, then all non-terminal jobs, then any
    // ancestor of a retained job so a retained lineage stays intact.
    const newest = [...terminal]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.updatedAt.localeCompare(b.updatedAt) || a.jobId.localeCompare(b.jobId))
      .slice(-MAX_RETAINED_TERMINAL_JOBS);
    const retainedIds = new Set<string>(newest.map((job) => job.jobId));
    for (const job of jobs.values()) {
      if (!isTerminal(job.status)) retainedIds.add(job.jobId);
    }
    for (const job of jobs.values()) {
      if (!retainedIds.has(job.jobId)) continue;
      for (const ancestorId of ancestorsOf(job)) retainedIds.add(ancestorId);
    }

    rewriteLog(filePath, retainedIds);
    index = foldLog(filePath);
  };

  // Bound history that was written by an earlier runtime before exposing the
  // registry to callers.
  prune();

  return {
    filePath,
    append,
    createJob(job: Job): void {
      append({ type: "created", job, at: job.createdAt });
      index.set(job.jobId, job);
      prune();
    },
    updateJob(jobId: string, update: JobUpdate): void {
      const current = index.get(jobId);
      if (!current) return;
      const to = update.status;
      if (to !== undefined && !canTransition(current.status, to)) return;
      const next = updateJob(current, update);
      append({ type: "updated", jobId, update, at: next.updatedAt });
      index.set(jobId, next);
      prune();
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
    prune,
  };
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
  sessionId?: string;
  parentSessionId?: string;
  sessionFile?: string;
  parentAgentIds?: readonly string[];
}): Job {
  const job = createJob(input);
  registry.createJob(job);
  return job;
}

export { createJob, updateJob };
export type { Job };