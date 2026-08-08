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
  readonly rootSessionId?: string;
}

/**
 * Mark active jobs interrupted, then abort the corresponding live children.
 *
 * A queued child is not yet a running process, so only running jobs are swept.
 * Registry transitions and the missing-control case are both intentionally
 * idempotent: a second sweep sees no running job, and a job may be between gate
 * admission and child-control registration when shutdown begins.
 */
export async function interruptRunningJobs(deps: InterruptionSweepDeps): Promise<void> {
  const scopedJobs = deps.rootSessionId === undefined
    ? Array.from(deps.registry.all().values())
    : sessionTreeJobs((jobId) => deps.registry.get(jobId), deps.registry.all(), deps.rootSessionId);
  const runningJobs = scopedJobs.filter((job): job is Job => job.status === "running");

  // A caller that provides a session root must only see that root's recursive
  // descendants. The unscoped form remains available to direct runtime users
  // and preserves the existing sweep contract for tests and adapters.

  for (const job of runningJobs) {
    deps.registry.updateJob(job.jobId, { status: "interrupted" });
  }

  await Promise.all(
    runningJobs.map(async (job) => {
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
  let inFlight: Promise<void> | undefined;

  return (rootSessionId?: string): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = interruptRunningJobs({
      ...deps,
      rootSessionId: rootSessionId ?? deps.rootSessionId,
    }).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
