/**
 * Per-session model binding registry for spawned child sessions.
 *
 * The patched host AgentSession hooks (turn_start rotation and failure
 * fail-over) run inside the SDK with no access to pi-c2's runtime state, so
 * the child adapter publishes each child's binding here under a stable
 * `Symbol.for` key. The patch reads the registry by session id to decide:
 *
 *   - `{ kind: "group", groupId }` — rotate/fail-over inside that named group.
 *   - `{ kind: "pinned" }` — never switch models; explicit config wins.
 *   - absent — inherit behavior: follow the home-wide active group.
 *
 * The registry is process-global by design (one entry per live/retained
 * child) and bounded with FIFO eviction so long-lived hosts cannot leak
 * memory through abandoned sessions that never released their binding.
 */

export type ChildSessionModelBinding =
  | {
      readonly kind: "group";
      readonly groupId: string;
      /** Resolved start identity, surfaced by TUI footer reads. */
      readonly provider?: string;
      readonly modelId?: string;
      readonly thinking?: string;
      readonly contextWindow?: number;
    }
  | {
      readonly kind: "pinned";
      readonly provider?: string;
      readonly modelId?: string;
      readonly thinking?: string;
      readonly contextWindow?: number;
    }
  | {
      /** Follows the home-wide active selection; identity reflects the spawn-time model. */
      readonly kind: "inherit";
      readonly provider?: string;
      readonly modelId?: string;
      readonly thinking?: string;
      readonly contextWindow?: number;
    };

/** Stable cross-boundary key; mirrors the host patch's lookup. */
export const CHILD_MODEL_BINDINGS_KEY = "pi-c2.child-model-bindings";

/** Upper bound on retained bindings; oldest entries are evicted first. */
export const MAX_CHILD_MODEL_BINDINGS = 4096;

interface BindingRegistry {
  readonly bindings: Map<string, ChildSessionModelBinding>;
  /** Method form so the patched host can resolve one binding by session id. */
  readonly getChildModelBinding: (sessionId: string | undefined) => ChildSessionModelBinding | undefined;
}

// Installed eagerly so the patched host can consult the key at any time,
// even before the first child publishes its binding.
const state: BindingRegistry = (() => {
  const globalScope = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const existing = globalScope[Symbol.for(CHILD_MODEL_BINDINGS_KEY)];
  if (
    existing &&
    typeof existing === "object" &&
    "bindings" in existing &&
    "getChildModelBinding" in existing
  ) {
    return existing as BindingRegistry;
  }
  const bindings = new Map<string, ChildSessionModelBinding>();
  const created: BindingRegistry = {
    bindings,
    getChildModelBinding(sessionId) {
      if (!sessionId) return undefined;
      return bindings.get(sessionId);
    },
  };
  globalScope[Symbol.for(CHILD_MODEL_BINDINGS_KEY)] = created;
  return created;
})();

/** Publish (or replace) one child session's model binding. */
export function publishChildModelBinding(sessionId: string, binding: ChildSessionModelBinding): void {
  if (!sessionId) return;
  // Delete first so re-publishing moves the id to the eviction tail.
  state.bindings.delete(sessionId);
  while (state.bindings.size >= MAX_CHILD_MODEL_BINDINGS) {
    const oldest = state.bindings.keys().next();
    if (oldest.done) break;
    state.bindings.delete(oldest.value);
  }
  state.bindings.set(sessionId, binding);
}

/** Read one child session's binding; undefined means inherit. */
export function getChildModelBinding(sessionId: string | undefined): ChildSessionModelBinding | undefined {
  return state.getChildModelBinding(sessionId);
}

/** Remove one child session's binding. Idempotent. */
export function releaseChildModelBinding(sessionId: string | undefined): void {
  if (!sessionId) return;
  state.bindings.delete(sessionId);
}
