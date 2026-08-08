import { MAX_CONCURRENCY } from "@xzy-ai/core";
import type { ChildSessionControl } from "@xzy-ai/core";
import { createScopedRegistry, type ScopedRegistry } from "../registry/scoped-registry.ts";
import { createDeliveryCoordinator, type DeliveryCoordinator } from "./delivery.ts";
import { createConcurrencyGate, type ConcurrencyGate } from "./concurrency-gate.ts";
import { createInterruptionSweep } from "./interruption.ts";

/**
 * Shared per-project runtime state.
 *
 * The pool is deliberately independent of the PI SDK. It owns the mutable
 * runtime state that must survive extension factory reloads and session
 * replacement: the append-only job registry writer, the live child handles,
 * the concurrency gate, the pending-result queue, and the interrupted-job
 * sweep. Later phases attach the remaining fields to this object.
 */
export interface ChildPool {
  readonly projectRoot: string;
  /** Session-scoped registry for all job lifecycle and manager operations. */
  readonly registry: ScopedRegistry;
  /** Alias retained for manager callers that name the scoped view explicitly. */
  readonly scopedRegistry: ScopedRegistry;
  /** Live root session id registered by the current host session, if known. */
  readonly rootSessionId?: string;
  /** Global child-run gate: at most MAX_CONCURRENCY children run at once. */
  readonly concurrency: ConcurrencyGate;
  /** Delivers finished background results to each result's direct parent session. */
  readonly delivery: DeliveryCoordinator;
  /** Live child handles keyed by job id; populated while a child runs. */
  readonly liveChildren: Map<string, ChildSessionControl>;
  /**
   * Observable source of live child activity.
   *
   * Fires whenever a live child is published or its feed emits, so UI surfaces
   * (the agent-activity ticker) can re-read the live children without reaching
   * into pool internals. The event carries no payload: consumers read
   * `liveChildren` for the current state.
   */
  readonly liveActivity: LiveActivitySource;
  /**
   * Mark running jobs interrupted and abort their children.
   *
   * Idempotent and shared: invoked from the lifecycle adapter when the host
   * process quits, and per-session when a root session is replaced by `/new`.
   */
  readonly interruptRunningJobs: () => Promise<void>;
  /** Reset the per-response agent-call counter; called from `turn_start`. */
  resetParallelAgents(): void;
}

/** Subscription surface for live child activity changes. */
export interface LiveActivitySource {
  subscribe(listener: () => void): () => void;
}

declare global {
  // Projects are keyed by their resolved root. The slot uses a "pi-code:"
  // prefix so it cannot collide with other string properties on globalThis.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  var piCodePool: Record<string, ChildPool>;
}

const POOL_SLOT_PREFIX = "pi-code:";

function poolSlot(projectRoot: string): string {
  return `${POOL_SLOT_PREFIX}${projectRoot}`;
}

export function getChildPool(projectRoot: string, rootSessionId?: string): ChildPool {
  const slot = poolSlot(projectRoot);
  const shared = globalThis.piCodePool?.[slot];
  if (shared) return shared;

  // The scoped registry is the single authoritative job store. It is created
  // with the root live session id so the root session's folder (which is not a
  // job) is scoped correctly; child job records carry their own parent session
  // id and route to their parent's folder on append.
  const registry = createScopedRegistry(projectRoot, rootSessionId);
  const liveChildren = new Map<string, ChildSessionControl>();
  const activityListeners = new Set<() => void>();
  const notifyActivity = (): void => {
    for (const listener of [...activityListeners]) listener();
  };
  const liveActivity: LiveActivitySource = {
    subscribe(listener: () => void): () => void {
      activityListeners.add(listener);
      return () => activityListeners.delete(listener);
    },
  };

  const pool: ChildPool = {
    projectRoot,
    registry,
    scopedRegistry: registry,
    rootSessionId,
    concurrency: createConcurrencyGate(MAX_CONCURRENCY),
    delivery: createDeliveryCoordinator(),
    liveChildren,
    liveActivity,
    interruptRunningJobs: createInterruptionSweep({ registry, liveChildren }),
    resetParallelAgents(): void {
      pool.concurrency.resetParallelCount();
    },
  };

  // Publish live children into the activity source as they appear so the ticker
  // observes each running agent. The child's own feed drives subsequent
  // notifications, so the ticker re-reads the latest transcript on every emit.
  const originalSet = liveChildren.set.bind(liveChildren);
  liveChildren.set = (jobId: string, control: ChildSessionControl): Map<string, ChildSessionControl> => {
    const result = originalSet(jobId, control);
    control.live?.subscribe(() => notifyActivity());
    notifyActivity();
    return result;
  };

  if (!globalThis.piCodePool) {
    globalThis.piCodePool = {};
  }
  globalThis.piCodePool[slot] = pool;
  return pool;
}
