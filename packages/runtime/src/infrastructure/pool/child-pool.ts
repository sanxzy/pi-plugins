import type { ChildSessionControl } from "@xzy-ai/core";
import { createAgentEventRegistry, type AgentEventRegistry } from "../registry/agent-event-registry.ts";
import { readSessionManifest } from "../manifests/manifests.ts";
import { canonicalProjectRoot } from "../../shared/paths.ts";
import { createDeliveryCoordinator, type DeliveryCoordinator } from "./delivery.ts";
import { createConcurrencyGate, type ConcurrencyGate } from "./concurrency-gate.ts";
import { createInterruptionSweep } from "./interruption.ts";
import { resolveSettingsForProject } from "../../shared/settings.ts";


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
  readonly registry: AgentEventRegistry;
  /** Alias retained for manager callers that name the scoped view explicitly. */
  readonly scopedRegistry: AgentEventRegistry;
  // Root/child detection is based on the persisted session boundary.
  readonly isRootSession: (sessionId: string) => boolean;
  /** Explicit startup/replacement bootstrap check before a root manifest exists. */
  readonly shouldBootstrapRootSession: (sessionId: string) => boolean;
  /** Resolve the live root session id that owns a caller/job session. */
  readonly rootSessionIdFor: (sessionId: string) => string;
  /** Live root session id registered by the current host session, if known. */
  readonly rootSessionId?: string;
  /** Global child-run gate: at most MAX_CONCURRENCY children run at once. */
  readonly concurrency: ConcurrencyGate;
  /**
   * Delivery coordinator for one root session, lazily created. Each root
   * session owns its own durable pending queue under its session directory,
   * so results addressed to one session's descendants stay isolated.
   */
  readonly deliveryFor: (rootSessionId: string) => DeliveryCoordinator;
  /** Live child handles keyed by job id; populated while a child runs. */
  readonly liveChildren: Map<string, ChildSessionControl>;
  /** Abort controllers for queued/running jobs, including jobs not yet admitted. */
  readonly jobAbortControllers?: Map<string, AbortController>;
  /**
   * Background launch leases keyed by job id, held from first launch until the
   * child settles. Concurrent `agent(agent_id)` calls for the same terminal or
   * queued job consult this map so only one child is ever started for it.
   */
  readonly launchingJobs: Map<string, Promise<void>>;
  /** Rebind the registry's new-job storage boundary to a replacement root. */
  rebindRootSession(rootSessionId: string): void;
  /**
   * Mark running jobs interrupted and abort their children.
   *
   * Idempotent and shared: invoked from the lifecycle adapter when the host
   * process quits, and per-session when a root session is replaced by `/new`.
   */
  readonly interruptRunningJobs: (rootSessionId?: string) => Promise<void>;
  /** Reset the per-response agent-call counter; called from `turn_start`. */
  resetParallelAgents(): void;
}

declare global {
  // Projects are keyed by their resolved root. The slot uses a "pi-c2:"
  // prefix so it cannot collide with other string properties on globalThis.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  var piC2Pool: Record<string, ChildPool>;
}

const POOL_SLOT_PREFIX = "pi-c2:";

function poolSlot(projectRoot: string): string {
  return `${POOL_SLOT_PREFIX}${canonicalProjectRoot(projectRoot)}`;
}

export function getChildPool(projectRoot: string, rootSessionId?: string): ChildPool {
  const slot = poolSlot(projectRoot);
  const shared = globalThis.piC2Pool?.[slot];
  if (shared) {
    // The pool is a process singleton that must survive extension reloads,
    // but a reloaded runtime version can need capabilities the previous
    // module graph did not attach. Upgrade the surviving singleton in place so
    // identity, live child handles, concurrency accounting, and the durable
    // registry are preserved while any missing members are patched on.
    upgradePool(shared, projectRoot, rootSessionId);
    return shared;
  }

  const pool = createPool(projectRoot, rootSessionId);

  if (!globalThis.piC2Pool) {
    globalThis.piC2Pool = {};
  }
  globalThis.piC2Pool[slot] = pool;
  return pool;
}

function createPool(projectRoot: string, rootSessionId?: string): ChildPool {
  // The scoped registry is the single authoritative job store. It is created
  // with the root live session id so the root session's folder (which is not a
  // job) is scoped correctly; child job records carry their own parent session
  // id and route to their parent's folder on append.
  const registry = createAgentEventRegistry(projectRoot, rootSessionId);
  const liveChildren = new Map<string, ChildSessionControl>();
  const jobAbortControllers = new Map<string, AbortController>();
  const launchingJobs = new Map<string, Promise<void>>();
  const deliveries = new Map<string, DeliveryCoordinator>();
  const rootSessionIdFor = (sessionId: string): string => {
    // Walk a caller/job session up to its root: a job records its parent
    // session, and the parent session that has no own job is the live root.
    let current = registry.getBySessionId(sessionId);
    let root = sessionId;
    const seen = new Set<string>();
    while (current && !seen.has(current.sessionId ?? current.jobId)) {
      const parentSessionId = current.parentSessionId;
      if (parentSessionId === undefined) break;
      seen.add(current.sessionId ?? current.jobId);
      root = parentSessionId;
      const parent = registry.getBySessionId(parentSessionId);
      if (parent) current = parent;
      else break;
    }
    return root;
  };
  const deliveryFor = (sessionId: string): DeliveryCoordinator => {
    const existing = deliveries.get(sessionId);
    if (existing) return existing;
    const coordinator = createDeliveryCoordinator({
      projectRoot,
      rootSessionId: sessionId,
      retryDelayMs: resolveSettingsForProject(projectRoot).runtime.deliveryRetryDelayMs,
      onDelivered: (jobId) => registry.updateJob(jobId, { delivered: true }),
    });
    deliveries.set(sessionId, coordinator);
    return coordinator;
  };

  const pool: ChildPool = {
    projectRoot,
    registry,
    scopedRegistry: registry,
    rootSessionId,
    isRootSession: (sessionId: string) => {
      if (registry.getBySessionId(sessionId) !== undefined) return false;
      try {
        const session = readSessionManifest(canonicalProjectRoot(projectRoot), sessionId);
        return session.sessionId === sessionId && session.active;
      } catch {
        return false;
      }
    },
    shouldBootstrapRootSession: (sessionId: string) => {
      // Any session that is not represented by an agent event is a candidate
      // root at the lifecycle boundary. The session-start adapter is the only
      // caller that may use this pre-manifest predicate; ordinary callers use
      // isRootSession(), which remains manifest-backed and fail-closed.
      return registry.getBySessionId(sessionId) === undefined;
    },
    concurrency: createConcurrencyGate(resolveSettingsForProject(projectRoot).agents.maxConcurrency),
    deliveryFor,
    rootSessionIdFor,
    liveChildren,
    jobAbortControllers,
    launchingJobs,
    rebindRootSession(nextRootSessionId: string): void {
      registry.rebindRootSession(nextRootSessionId);
    },
    interruptRunningJobs: createInterruptionSweep({ registry, liveChildren, jobAbortControllers, rootSessionId }),
    resetParallelAgents(): void {
      pool.concurrency.resetParallelCount();
    },
  };
  return pool;
}

/**
 * Patch capabilities onto a surviving pool that an older runtime left stale.
 *
 * The pool object is keyed on `globalThis` and deliberately outlives extension
 * factory reloads, so the module graph may be replaced while the object is not.
 * Any interface member the current runtime expects but the object lacks (for
 * example the per-session `deliveryFor` / `rootSessionIdFor` surface added by
 * a later merge) is attached in place over the shared durable registry. Live
 * child handles, the concurrency gate, and the append-only registry survive so
 * running children keep their steering/cancellation handles.
 *
 * Adding a new `ChildPool` member in future commits should attach it here too,
 * guarded by a `typeof` presence check, so an upgrade never regresses to a
 * stale object.
 */
function upgradePool(pool: ChildPool, projectRoot: string, rootSessionId?: string): void {
  const patch = (key: string, value: unknown): void => {
    Object.defineProperty(pool, key, { value, configurable: true, writable: true });
  };
  let registry = pool.registry;
  if (typeof registry.refresh !== "function") {
    // A pre-refresh registry cannot observe home cleanup. Rebuild only the
    // read-model object from authoritative event logs; preserve the pool,
    // concurrency gate, live child handles, and durable on-disk jobs.
    registry = createAgentEventRegistry(projectRoot, pool.rootSessionId ?? rootSessionId);
    patch("registry", registry);
    patch("scopedRegistry", registry);
  }
  // A surviving pool is already the authoritative in-process read model. Do
  // not refresh it on every getChildPool() call: callers reach this function
  // on the hot spawn path, and refresh() recursively scans every home event
  // log. Lifecycle boundaries and explicit recovery call refresh() instead.

  if (typeof pool.rootSessionIdFor !== "function") {
    patch("rootSessionIdFor", (sessionId: string): string => {
      let current = registry.getBySessionId(sessionId);
      let root = sessionId;
      const seen = new Set<string>();
      while (current && !seen.has(current.sessionId ?? current.jobId)) {
        const parentSessionId = current.parentSessionId;
        if (parentSessionId === undefined) break;
        seen.add(current.sessionId ?? current.jobId);
        root = parentSessionId;
        const parent = registry.getBySessionId(parentSessionId);
        if (parent) current = parent;
        else break;
      }
      return root;
    });
  }
  if (typeof pool.deliveryFor !== "function") {
    const deliveries = new Map<string, DeliveryCoordinator>();
    patch("deliveryFor", (sessionId: string): DeliveryCoordinator => {
      const existing = deliveries.get(sessionId);
      if (existing) return existing;
      const coordinator = createDeliveryCoordinator({
        projectRoot,
        rootSessionId: sessionId,
        retryDelayMs: resolveSettingsForProject(projectRoot).runtime.deliveryRetryDelayMs,
        onDelivered: (jobId) => registry.updateJob(jobId, { delivered: true }),
      });
      deliveries.set(sessionId, coordinator);
      return coordinator;
    });
  }
  if (pool.scopedRegistry === undefined) {
    patch("scopedRegistry", registry);
  }
  if (typeof pool.isRootSession !== "function") {
    patch("isRootSession", (sessionId: string): boolean => {
      if (registry.getBySessionId(sessionId) !== undefined) return false;
      try {
        const session = readSessionManifest(canonicalProjectRoot(projectRoot), sessionId);
        return session.sessionId === sessionId && session.active;
      } catch {
        return false;
      }
    });
  }
  if (typeof pool.shouldBootstrapRootSession !== "function") {
    patch("shouldBootstrapRootSession", (sessionId: string): boolean => registry.getBySessionId(sessionId) === undefined);
  }
  if (pool.jobAbortControllers === undefined) {
    patch("jobAbortControllers", new Map<string, AbortController>());
  }
  if (pool.launchingJobs === undefined) {
    patch("launchingJobs", new Map<string, Promise<void>>());
  }
  if (typeof pool.rebindRootSession !== "function") {
    patch("rebindRootSession", (nextRootSessionId: string): void => {
      if (typeof registry.rebindRootSession === "function") registry.rebindRootSession(nextRootSessionId);
    });
  }
  // Always rebuild the sweep after upgrading so it closes over the current
  // registry and controller map, while preserving the stable pool identity.
  patch("interruptRunningJobs", createInterruptionSweep({ registry, liveChildren: pool.liveChildren, jobAbortControllers: pool.jobAbortControllers, rootSessionId }));
  if (typeof pool.resetParallelAgents !== "function" && pool.concurrency) {
    patch("resetParallelAgents", (): void => pool.concurrency.resetParallelCount());
  }
}
