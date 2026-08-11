import type { Job } from "@xzy-ai/core";
import type { ChildSessionControl } from "@xzy-ai/core";
import { isTerminal } from "@xzy-ai/core";
import type { Registry } from "../registry/registry.ts";
import type { ScopedRegistry } from "../registry/scoped-registry.ts";

export type ScopeRegistry = Pick<Registry | ScopedRegistry, "all" | "get">;

/**
 * Return the recursive job tree rooted at one live parent session.
 *
 * Direct children are selected by `parentSessionId`; each child session then
 * becomes the focus for the next level. Terminal records remain in the result so
 * callers can use the projection for both live lifecycle work and history views.
 */
export function sessionTreeJobs(
  getJob: (jobId: string) => Job | undefined,
  jobs: ReadonlyMap<string, Job>,
  rootSessionId: string,
): Job[] {
  const byParent = new Map<string, Job[]>();
  for (const job of jobs.values()) {
    if (!job.parentSessionId) continue;
    const children = byParent.get(job.parentSessionId) ?? [];
    children.push(job);
    byParent.set(job.parentSessionId, children);
  }

  const result: Job[] = [];
  const visit = (parentSessionId: string): void => {
    for (const job of byParent.get(parentSessionId) ?? []) {
      result.push(job);
      const childSessionId = sessionIdOf(job, getJob);
      if (childSessionId) visit(childSessionId);
    }
  };
  visit(rootSessionId);
  return result;
}

/**
 * A rendered row from a recursive session-tree projection.
 */
export interface ScopedSessionRow {
  readonly jobId: string;
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly subject: string;
  readonly status: Job["status"];
  readonly description: string;
  readonly depth: number;
  readonly durationMs: number;
  readonly enterable: boolean;
  readonly rowId: string;
}

export function scopeDescendants(
  getJob: (jobId: string) => Job | undefined,
  jobs: ReadonlyMap<string, Job>,
  rootSessionId: string,
  liveChildren: ReadonlyMap<string, ChildSessionControl>,
  now: Date,
): ScopedSessionRow[] {
  const byParent = new Map<string, Job[]>();
  for (const job of jobs.values()) {
    const parent = job.parentSessionId;
    if (!parent) continue;
    const list = byParent.get(parent) ?? [];
    list.push(job);
    byParent.set(parent, list);
  }

  const ordered = new Map<string, Job[]>();
  for (const [parent, list] of byParent) {
    ordered.set(parent, list.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  }

  const rows: ScopedSessionRow[] = [];

  const visit = (focusSessionId: string, depth: number): void => {
    const children = ordered.get(focusSessionId) ?? [];
    for (const job of children) {
      const row = toRow(job, depth, liveChildren, now);
      rows.push(row);
      const childSessionId = sessionIdOf(job, getJob);
      if (childSessionId) {
        visit(childSessionId, depth + 1);
      }
    }
  };

  visit(rootSessionId, 0);
  return rows;
}

/** Convenience wrapper over a scoped registry shared by the manager. */
export function scopeRegistry(
  registry: ScopeRegistry,
  rootSessionId: string,
  liveChildren: ReadonlyMap<string, ChildSessionControl>,
  now?: Date,
): ScopedSessionRow[] {
  return scopeDescendants(
    (jobId) => registry.get(jobId),
    registry.all(),
    rootSessionId,
    liveChildren,
    now ?? new Date(),
  );
}

function sessionIdOf(job: Job, getJob: (jobId: string) => Job | undefined): string | undefined {
  // A child's own folder is keyed by its live session id, which is normally its
  // job id. A resumed job's session id was rewritten into its transcript, so it
  // may differ from the job id; fall back to the job id.
  return job.sessionId ?? getJob(job.jobId)?.sessionId ?? job.jobId;
}

function liveChildFor(
  liveChildren: ReadonlyMap<string, ChildSessionControl>,
  jobId: string,
): ChildSessionControl | undefined {
  return liveChildren.get(jobId) ?? liveChildren.get(jobId.replace(/^job-/, "")) ?? [...liveChildren.entries()].find(([id]) => id.replace(/^job-/, "") === jobId.replace(/^job-/, ""))?.[1];
}

function toRow(
  job: Job,
  depth: number,
  liveChildren: ReadonlyMap<string, ChildSessionControl>,
  now: Date,
): ScopedSessionRow {
  const start = new Date(job.createdAt).getTime();
  const endTime = isTerminal(job.status) ? new Date(job.updatedAt).getTime() : now.getTime();
  const durationMs = Math.max(0, endTime - start);
  const enterable = job.status === "running" && liveChildFor(liveChildren, job.jobId) !== undefined;
  return {
    jobId: job.jobId,
    sessionId: job.sessionId ?? job.jobId,
    parentSessionId: job.parentSessionId,
    subject: job.description,
    status: job.status,
    description: job.description,
    depth,
    durationMs,
    enterable,
    rowId: job.jobId,
  };
}
