import { existsSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { allMcpNames, sessionMcpNames } from "@xzy-ai/core";
import { canonicalProjectRoot, cleanupRootSessions } from "@xzy-ai/channels";
import { currentProcessIdentity, encodeProjectId, finishRootSession, getChildPool, getGoalPool, homeSessionManifestFile, startRootSession, type GoalDeliveryBinding } from "@xzy-ai/runtime";

const SESSION_RELOAD_MARKERS_KEY = Symbol.for("@xzy-ai/pi-code:session-reload-markers");
type SessionReloadMarkers = Map<string, boolean>;

function sessionReloadMarkers(): SessionReloadMarkers {
  const global = globalThis as unknown as Record<symbol, SessionReloadMarkers | undefined>;
  global[SESSION_RELOAD_MARKERS_KEY] ??= new Map<string, boolean>();
  return global[SESSION_RELOAD_MARKERS_KEY] as SessionReloadMarkers;
}

/** Mark the next fresh session_start for a project as a reload continuation. */
export function markSessionReload(projectRoot: string): void {
  sessionReloadMarkers().set(canonicalProjectRoot(projectRoot), true);
}

/** Consume the reload marker for a project. */
export function takeSessionReload(projectRoot: string): boolean {
  const markers = sessionReloadMarkers();
  const key = canonicalProjectRoot(projectRoot);
  const marked = markers.get(key) === true;
  markers.delete(key);
  return marked;
}

/** Clear a marker when the reload operation fails before session_start. */
export function clearSessionReload(projectRoot: string): void {
  sessionReloadMarkers().delete(canonicalProjectRoot(projectRoot));
}

function goalBinding(pi: ExtensionAPI, ctx: ExtensionContext): GoalDeliveryBinding {
  return {
    cwd: ctx.cwd,
    hasUI: ctx.hasUI,
    sendUserMessage: (content, options) => pi.sendUserMessage(content, options),
    notify: (message, type) => {
      if (ctx.hasUI) ctx.ui.notify(message, type);
    },
  };
}

/**
 * Register the per-session lifecycle events.
 *
 * `turn_start` resets the per-response parallel-agent budget; `session_start`
 * registers the session's result sink (rebinding pending results on fork);
 * `session_shutdown` unregisters the sink and, for the root session only,
 * interrupts running jobs on process quit or `/new`.
 */
export function registerSessionEvents(pi: ExtensionAPI): void {
  pi.on("turn_start", (_event: TurnStartEvent, ctx: ExtensionContext) => {
    // A turn is one model response and its tool batch. Resetting here means
    // separate responses get independent MAX_PARALLEL_AGENTS budgets while the
    // pool still shares the counter across all agent calls in this response.
    getChildPool(ctx.cwd, ctx.sessionManager.getSessionId()).resetParallelAgents();
  });

  pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
    const projectRoot = canonicalProjectRoot(ctx.cwd);
    const sessionId = ctx.sessionManager.getSessionId();
    const rootPool = getChildPool(ctx.cwd, sessionId);
    // A root host has no agent event. The bootstrap predicate applies only to
    // this real lifecycle boundary; ordinary callers use manifest-backed
    // isRootSession. This covers a first host and every replacement root
    // (/new, reload, resume) that has not yet created its session manifest.
    const isRootSession = rootPool.shouldBootstrapRootSession(sessionId) || rootPool.isRootSession(sessionId);
    if (isRootSession) {
      const identity = currentProcessIdentity();
      startRootSession({
        projectRoot,
        sessionId,
        sessionFile: ctx.sessionManager.getSessionFile(),
        pid: identity.pid,
        processStartTime: identity.processStartTime,
      });
      // Reconcile crashed roots and retain at most 200 inactive sessions before
      // this host begins channel/goal delivery. Project channel state is not in
      // the removable session subtree.
      cleanupRootSessions(projectRoot, {
        currentPid: identity.pid,
        currentProcessStartTime: identity.processStartTime,
      });
      if (takeSessionReload(projectRoot)) {
        // This handler runs in the fresh runtime after reload; unlike the old
        // command frame, this pi API is valid and can steer the model safely.
        pi.sendUserMessage("Your session was reloaded.", { deliverAs: "steer" });
      }
    }

    // Activate every registered tool so built-ins beyond the default
    // read/bash/edit/write (find, grep) are model-callable too. `ls` stays
    // excluded — the model should list files via `find`/`grep` instead.
    const managedNames = new Set(allMcpNames());
    const currentSessionNames = new Set(sessionMcpNames(ctx.cwd, sessionId));
    pi.setActiveTools(
      pi
        .getAllTools()
        .map((tool) => tool.name)
        .filter((name) => name !== "ls" && (!managedNames.has(name) || currentSessionNames.has(name))),
    );

    // Bind the goal pool to the fresh host. Goals are strictly per-root
    // session: a new, resumed, reloaded, or forked root never inherits or is
    // offered continuation of another session's goal, so delivery starts only
    // for the current root's own persisted goal (if any).
    const goalPool = getGoalPool(ctx.cwd, sessionId);
    goalPool.bind(goalBinding(pi, ctx));
    goalPool.resumeDelivery();

    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;

    // The root orchestrator session is not a job, but its live session id still
    // owns a session-scoped folder; the pool registers it as the scoped root so
    // the manager tree is seeded from it. Forked sessions get their own id.
    const pool = getChildPool(ctx.cwd, sessionId);
    pool.registry.ensureSession(sessionId);
    if (event.reason === "fork" && event.previousSessionFile) {
      // Fork creates the descendant before this event. Pending results that
      // were addressed to the replaced parent must follow that descendant.
      pool.delivery.rebind(event.previousSessionFile, sessionFile);
    }
    pool.delivery.register(sessionFile, (content) => {
      // Steer the active parent session immediately. The SDK host owns the
      // actual parent session.
      pi.sendUserMessage(content, { deliverAs: "steer" });
    });

    // A fresh host binding is established above before delivery resumes. The
    // goal pool does not retain the old session/UI handles across replacement.
  });

  pi.on("session_shutdown", async (event: SessionShutdownEvent, ctx: ExtensionContext) => {
    const rootSessionId = ctx.sessionManager.getSessionId();
    const pool = getChildPool(ctx.cwd, rootSessionId);
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) {
      pool.delivery.unregister(sessionFile);
    }
    // Child sessions also emit `quit` when they are disposed after settling.
    // Only the root orchestrator may sweep its own session tree; a child must
    // never abort its siblings or its parent while it is being cleaned up.
    const isChildSession = !pool.isRootSession(rootSessionId) && !pool.shouldBootstrapRootSession(rootSessionId);
    if (isChildSession) return;

    // Process quit and a confirmed `/new` both terminate the current host
    // session's background work. Reload/resume/fork preserve live children.
    if (event.reason === "quit" || event.reason === "new") {
      await pool.interruptRunningJobs(rootSessionId);
    }
    // Only sessions that were actually started as a root session carry a home
    // session manifest. Tests and legacy callers that fire `session_shutdown`
    // without a matching `session_start` must not fail closed here.
    const rootSessionFile = homeSessionManifestFile(encodeProjectId(canonicalProjectRoot(ctx.cwd)), rootSessionId);
    if (existsSync(rootSessionFile)) {
      finishRootSession({
        projectRoot: canonicalProjectRoot(ctx.cwd),
        sessionId: rootSessionId,
        reason: event.reason,
      });
    }
    // Every root host teardown stops delivery and removes only this root
    // session's persisted goal store. Other root sessions and project-level
    // channel state remain untouched.
    const goalPool = getGoalPool(ctx.cwd, rootSessionId);
    goalPool.clearStore();
  });
}