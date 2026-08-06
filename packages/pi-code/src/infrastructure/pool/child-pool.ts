import type { JobSummary } from "../../shared/types.ts";

/**
 * Minimal shared runtime state for Phase 1.
 *
 * The pool is deliberately independent of the PI SDK. Later phases add live
 * child handles, the registry writer, the concurrency gate, and pending result
 * delivery to this per-project state object.
 */
export interface ChildPool {
  readonly projectRoot: string;
  readonly jobs: Map<string, JobSummary>;
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

  const pool: ChildPool = {
    projectRoot,
    jobs: new Map(),
  };

  if (!globalThis.piCodePool) {
    globalThis.piCodePool = {};
  }
  globalThis.piCodePool[slot] = pool;
  return pool;
}
