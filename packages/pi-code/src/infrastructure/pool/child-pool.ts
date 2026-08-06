import { MAX_CONCURRENCY } from "../../shared/constants.ts";
import { registryFile } from "../../shared/paths.ts";
import type { ChildSessionControl } from "../../domain/ports/child-session.ts";
import { createRegistry, type Registry } from "../registry/registry.ts";
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
  readonly registry: Registry;
  /** Global child-run gate: at most MAX_CONCURRENCY children run at once. */
  readonly concurrency: ConcurrencyGate;
  /** Delivers finished background results to each result's direct parent session. */
  readonly delivery: DeliveryCoordinator;
  /** Live child handles keyed by job id; populated while a child runs. */
  readonly liveChildren: Map<string, ChildSessionControl>;
  /**
   * Mark running jobs interrupted and abort their children.
   *
   * Idempotent and shared: invoked from the lifecycle adapter when the host
   * process quits, and per-session when a root session is replaced by `/new`.
   */
  readonly interruptRunningJobs: () => Promise<void>;
  /** Reset the per-response task-call counter; called from `turn_start`. */
  resetParallelTasks(): void;
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

export function getChildPool(projectRoot: string): ChildPool {
  const slot = poolSlot(projectRoot);
  const shared = globalThis.piCodePool?.[slot];
  if (shared) return shared;

  const registry = createRegistry(registryFile(projectRoot));
  const liveChildren = new Map<string, ChildSessionControl>();

  const pool: ChildPool = {
    projectRoot,
    registry,
    concurrency: createConcurrencyGate(MAX_CONCURRENCY),
    delivery: createDeliveryCoordinator(),
    liveChildren,
    interruptRunningJobs: createInterruptionSweep({ registry, liveChildren }),
    resetParallelTasks(): void {
      pool.concurrency.resetParallelCount();
    },
  };

  if (!globalThis.piCodePool) {
    globalThis.piCodePool = {};
  }
  globalThis.piCodePool[slot] = pool;
  return pool;
}
