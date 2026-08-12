/**
 * Shutdown interruption for active child jobs.
 *
 * The sweep is deliberately independent of the PI SDK. The pool supplies the
 * folded registry and live child controls; the lifecycle adapter decides when
 * the sweep should run for the host session. When a session root is supplied,
 * only jobs rooted at that live parent session are interrupted.
 */
import type { Job } from "@xzy-ai/core";
import type { ChildSessionControl } from "@xzy-ai/core";
import type { Registry } from "../registry/registry.ts";
import { sessionTreeJobs } from "../sessions/scope.ts";

export interface InterruptionSweepDeps {
  readonly registry: Pick<Registry, "all" | "get" | "updateJob">;
  readonly liveChildren: Map<string, ChildSessionControl>;
  /** Abort controllers include jobs waiting for concurrency admission. */
  readonly jobAbortControllers?: Map<string, AbortController>;
  readonly rootSessionId?: string;
}

/**
 * Abort one job and every recursive descendant so the whole subtree settles.
 *
 * The target may be a foreground parent currently blocked inside its `agent`
 * tool while a descendant is still running. Abort the entire recursive subtree
 * so every level's SDK `abort()` can reach idle instead of waiting on an
 * unresolved descendant tool call.
 *
 * Running nodes become `interrupted`, queued nodes `cancelled` — unless a
 * `terminalStatus` is provided, in which case every affected node is closed
 * with that status (used by `agent_cancel` to mark a deliberate cancellation).
 */
export async function abortJobTree(
  deps: Omit<InterruptionSweepDeps, "rootSessionId">,
  jobId: string,
  terminalStatus: "interrupted" | "cancelled" = "interrupted",
): Promise<void> {
  const jobs = deps.registry.all();
  const target = deps.registry.get(jobId);
  const rootSessionId = target?.sessionId ?? jobId;
  const tree = sessionTreeJobs((id) => deps.registry.get(id), jobs, rootSessionId);
  const ids = [...tree.map((job) => job.jobId).reverse(), jobId];
  const uniqueIds = [...new Set(ids)].filter((id) => {
    const job = deps.registry.get(id);
    return job && ["queued", "running"].includes(job.status);
  });

  // Abort every node concurrently. A foreground parent can be blocked inside
  // its `agent` tool awaiting a descendant; aborting the descendant resolves
  // the parent's wait-for-idle in the same pass instead of after it.
  await Promise.all(
    uniqueIds.map(async (id) => {
      const job = deps.registry.get(id)!;
      deps.jobAbortControllers?.get(id)?.abort();
      const control = deps.liveChildren.get(id);
      if (control) {
        try {
          await control.abort();
        } catch {
          // Continue aborting the rest of the subtree even if one abort fails.
        }
      }
      const status = terminalStatus === "cancelled"
        ? "cancelled"
        : job.status === "queued"
          ? "cancelled"
          : "interrupted";
      deps.registry.updateJob(id, { status });
    }),
  );
}

/**
 * Mark active jobs terminal, then abort the corresponding live children.
 *
 * Queued children are cancelled because they have not started a session yet;
 * running children are interrupted and aborted. Registry transitions and the
 * missing-control case are intentionally idempotent: a second sweep sees no
 * active job, and a job may be between gate admission and child-control
 * registration when shutdown begins.
 */
export async function interruptRunningJobs(deps: InterruptionSweepDeps): Promise<void> {
  const scopedJobs = deps.rootSessionId === undefined
    ? Array.from(deps.registry.all().values())
    : sessionTreeJobs((jobId) => deps.registry.get(jobId), deps.registry.all(), deps.rootSessionId);
  const runningJobs = scopedJobs.filter((job): job is Job => job.status === "running");

  // A caller that provides a session root must only see that root's recursive
  // descendants. The unscoped form remains available to direct runtime users
  // and preserves the existing sweep contract for tests and adapters.

  // A shutdown-scoped sweep cancels queued descendants because they must not
  // start after their parent exits. Preserve the unscoped adapter's historical
  // behavior for direct callers, which only interrupts running jobs.
  const queuedJobs = deps.rootSessionId === undefined
    ? []
    : scopedJobs.filter((job): job is Job => job.status === "queued");
  for (const job of queuedJobs) {
    deps.registry.updateJob(job.jobId, { status: "cancelled" });
    // Drop the queued gate waiter so a cancelled descendant never starts after
    // its parent exits.
    deps.jobAbortControllers?.get(job.jobId)?.abort();
  }

  for (const job of runningJobs) {
    deps.registry.updateJob(job.jobId, { status: "interrupted" });
  }

  await Promise.all(
    runningJobs.map(async (job) => {
      deps.jobAbortControllers?.get(job.jobId)?.abort();
      const control = deps.liveChildren.get(job.jobId);
      if (!control) return;
      try {
        await control.abort();
      } catch {
        // Shutdown must continue sweeping other children if one abort fails.
      }
    }),
  );
}

/**
 * Make the asynchronous sweep safe for overlapping lifecycle notifications.
 *
 * The shared pool uses one instance, so concurrent shutdown handlers share the
 * same in-flight operation instead of aborting a child twice.
 */
export function createInterruptionSweep(deps: InterruptionSweepDeps): (rootSessionId?: string) => Promise<void> {
  // Shutdowns for different parent sessions may overlap. Deduplicate only
  // identical scopes; sharing one promise across scopes could let a child
  // shutdown accidentally suppress the root's sibling-tree sweep.
  const inFlight = new Map<string, Promise<void>>();

  return (rootSessionId?: string): Promise<void> => {
    const scope = rootSessionId ?? deps.rootSessionId;
    const key = scope ?? "<all>";
    const existing = inFlight.get(key);
    if (existing) return existing;
    const operation = interruptRunningJobs({
      ...deps,
      rootSessionId: scope,
    }).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, operation);
    return operation;
  };
}
