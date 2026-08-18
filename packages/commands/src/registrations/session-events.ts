import { existsSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolDefinition,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { allMcpNames, sessionMcpActive, sessionMcpNames } from "@xzy-ai/core";
import { canonicalProjectRoot, cleanupRootSessions } from "@xzy-ai/channels";
import { SESSION_OPERATIONS, createSessionLogger, processWithLog, runWithLogContext, type SessionLogger } from "@xzy-ai/observability";
import { currentProcessIdentity, clearAgentDiscoveryCache, encodeProjectId, finishRootSession, getChildPool, getGoalPool, homeDailyErrorFile, homeDailyEventFile, homeSessionManifestFile, loadPonytailState, startRootSession, type GoalDeliveryBinding } from "@xzy-ai/runtime";
import { createHostMessageGate, type HostMessageGate } from "./safe-host-delivery.ts";
import { notifyHost } from "./notify-entry.ts";

const SESSION_RELOAD_MARKERS_KEY = Symbol.for("@xzy-ai/pi-c2:session-reload-markers");
type SessionReloadMarkers = Map<string, boolean>;

const HOST_GATES_KEY = Symbol.for("@xzy-ai/pi-c2:host-message-gates");
type HostGateRegistry = Map<string, HostMessageGate>;

function hostGateRegistry(): HostGateRegistry {
  const global = globalThis as unknown as Record<symbol, HostGateRegistry | undefined>;
  global[HOST_GATES_KEY] ??= new Map<string, HostMessageGate>();
  return global[HOST_GATES_KEY] as HostGateRegistry;
}

function hostGateKey(projectRoot: string, sessionId: string): string {
  return `${canonicalProjectRoot(projectRoot)}\u0000${sessionId}`;
}

function sessionReloadMarkers(): SessionReloadMarkers {
  const global = globalThis as unknown as Record<symbol, SessionReloadMarkers | undefined>;
  global[SESSION_RELOAD_MARKERS_KEY] ??= new Map<string, boolean>();
  return global[SESSION_RELOAD_MARKERS_KEY] as SessionReloadMarkers;
}

/** Mark the next fresh session_start for a project as a reload continuation. */
export function markSessionReload(projectRoot: string): void {
  sessionReloadMarkers().set(canonicalProjectRoot(projectRoot), true);
  // A reload may ship with a changed agent ecosystem (new/edited agent
  // markdown, changed precedence); drop discovery caches so the fresh runtime
  // rescans once instead of serving the pre-reload snapshot.
  clearAgentDiscoveryCache();
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

function sessionLogger(projectRoot: string, sessionId: string) {
  const projectId = encodeProjectId(projectRoot);
  const localDate = new Date().toISOString().slice(0, 10);
  return createSessionLogger({
    projectId,
    rootSessionId: sessionId,
    eventsPath: homeDailyEventFile(projectId, sessionId, localDate),
    errorsPath: homeDailyErrorFile(projectId, sessionId, localDate),
  });
}

function goalBinding(pi: ExtensionAPI, ctx: ExtensionContext, logger: SessionLogger, gate: HostMessageGate): GoalDeliveryBinding {
  return {
    cwd: ctx.cwd,
    hasUI: ctx.hasUI,
    sendUserMessage: (content, options) => gate.sendHidden(content, options?.deliverAs ?? "steer"),
    notify: (message) => notifyHost(pi, ctx, message),
    logger,
  };
}

/** Optional registration dependencies for the per-session lifecycle events. */
export interface SessionEventsOptions {
  /**
   * Ponytail `write`/`edit` wrapper definitions, supplied by the composition
   * root. When the session's effective Ponytail state is enabled they are
   * registered before the active-tool filter runs so the model sees the
   * required-ticket surface; when disabled nothing is registered and the host
   * built-in tools remain.
   */
  readonly ponytailWriteEditTools?: () => { readonly write: ToolDefinition<any, any, any>; readonly edit: ToolDefinition<any, any, any> };
}

/**
 * Register the per-session lifecycle events.
 *
 * `turn_start` resets the per-response parallel-agent budget; `session_start`
 * registers the session's result sink (rebinding pending results on fork);
 * `session_shutdown` unregisters the sink and, for the root session only,
 * interrupts running jobs on process quit or `/new`.
 */
export function registerSessionEvents(pi: ExtensionAPI, options: SessionEventsOptions = {}): void {
  pi.on("turn_start", (_event: TurnStartEvent, ctx: ExtensionContext) => {
    processWithLog({ operation: SESSION_OPERATIONS.TURN_START, parameters: { cwd: ctx.cwd } }, () => {
      // A turn is one model response and its tool batch. Resetting here means
      // separate responses get independent MAX_PARALLEL_AGENTS budgets while the
      // pool still shares the counter across all agent calls in this response.
      getChildPool(ctx.cwd, ctx.sessionManager.getSessionId()).resetParallelAgents();
    });
  });

  pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
    const projectRoot = canonicalProjectRoot(ctx.cwd);
    const sessionId = ctx.sessionManager.getSessionId();
    const logger = sessionLogger(projectRoot, sessionId);
    return runWithLogContext(logger, () => processWithLog(
      { operation: SESSION_OPERATIONS.START, parameters: { reason: event.reason } },
      async () => {
        await startSession(event, ctx, pi, projectRoot, sessionId, logger, options);
      },
    ));
  });

  async function startSession(event: SessionStartEvent, ctx: ExtensionContext, pi: ExtensionAPI, projectRoot: string, sessionId: string, logger: SessionLogger, options: SessionEventsOptions): Promise<void> {
    const rootPool = getChildPool(ctx.cwd, sessionId);
    // Host-bound model messages (reload notice, background results, goals) are
    // gated behind the agent's run state so they never race an active prompt
    // and never surface pi's "already processing a prompt" error during
    // session replacement (reload/new/resume).
    const gateKey = hostGateKey(projectRoot, sessionId);
    hostGateRegistry().get(gateKey)?.dispose();
    const gate = createHostMessageGate(pi, ctx);
    hostGateRegistry().set(gateKey, gate);
    // A root host has no agent event. The bootstrap predicate applies only to
    // this real lifecycle boundary; ordinary callers use manifest-backed
    // isRootSession. This covers a first host and every replacement root
    // (/new, reload, resume) that has not yet created its session manifest.
    const isRootSession = rootPool.shouldBootstrapRootSession(sessionId) || rootPool.isRootSession(sessionId);
    if (isRootSession) {
      // The shared pool survives `/new`, reload, and resume. Rebind the
      // registry before any child is created so event logs/manifests and
      // transcripts for this root session share the same storage boundary.
      rootPool.rebindRootSession(sessionId);
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
      // Authoritative rescan of the shared registry after cleanup: the pool
      // serves hot-path reads from memory, while this lifecycle boundary makes
      // external home changes (other processes and cleanup) visible before
      // this fresh root starts channel/goal delivery.
      rootPool.registry.refresh();
      if (takeSessionReload(projectRoot)) {
        // The fresh runtime's pi API is valid after reload. Gate the notice so
        // a reload performed while the previous turn still runs cannot collide
        // with an active prompt (pi prints "Agent is already processing a
        // prompt"); it is delivered once the host settles.
        gate.send("Your session was reloaded.");
      }
    }

    // Activate every registered tool so built-ins beyond the default
    // read/bash/edit/write (find, grep) are model-callable too. `ls` stays
    // excluded — the model should list files via `find`/`grep` instead.
    const managedNames = new Set(allMcpNames());
    const currentSessionNames = new Set(sessionMcpNames(ctx.cwd, sessionId));
    const mcpActive = sessionMcpActive(ctx.cwd, sessionId);
    const mcpResourceTools = new Set(["mcp_resources_list", "mcp_resources_read"]);
    const ponytailActive = loadPonytailState(sessionId, Date.now())?.enabled === true;
    // The Ponytail write/edit wrapper definitions are registered only for an
    // enabled session, before the active-tool filter computes the model-facing
    // surface. A disabled session never sees them; the host built-in write/edit
    // remain the only definitions. Registration is idempotent per runner, so a
    // reload that re-registers the same definitions is safe.
    if (ponytailActive) {
      const ponytailTools = options.ponytailWriteEditTools?.();
      if (ponytailTools) {
        pi.registerTool(ponytailTools.write);
        pi.registerTool(ponytailTools.edit);
      }
    }
    const markdownTools = new Set(["write_markdown", "edit_markdown"]);
    pi.setActiveTools(
      pi
        .getAllTools()
        .map((tool) => tool.name)
        .filter((name) => name !== "ls" && (ponytailActive || (!markdownTools.has(name) && name !== "create_write_edit_ticket")))
        .filter((name) => (mcpActive || !mcpResourceTools.has(name)) && (!managedNames.has(name) || currentSessionNames.has(name))),
    );

    // Bind the goal pool to the fresh host. Goals are strictly per-root
    // session: a new, resumed, reloaded, or forked root never inherits or is
    // offered continuation of another session's goal, so delivery starts only
    // for the current root's own persisted goal (if any).
    const goalPool = getGoalPool(ctx.cwd, sessionId);
    goalPool.bind(goalBinding(pi, ctx, logger, gate));
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
      pool.deliveryFor(pool.rootSessionIdFor(sessionId)).rebind(event.previousSessionFile, sessionFile);
    }
    const delivery = pool.deliveryFor(pool.rootSessionIdFor(sessionId));
    delivery.register(sessionFile, (content, meta) => {
      // Reject while the host agent is mid-run: the delivery coordinator keeps
      // the result durable pending and retries once the host settles, so a
      // background result is never lost to an active prompt and never surfaces
      // pi's "already processing a prompt" error. The gate's settled hook
      // redrives this coordinator the moment agent_end fires, so the result
      // does not wait for the coordinator's polling retry.
      if (!gate.trySendHidden(content, "steer")) {
        throw new Error("host agent is busy; defer result delivery");
      }
      if (ctx.hasUI) {
        const detail = meta ? ` (${meta.subagentType}, ${meta.jobId})` : "";
        notifyHost(pi, ctx, `Agent result delivered to the root session${detail}.`);
      }
    });
    gate.onSettled(() => delivery.redrive(sessionFile));

    // A fresh host binding is established above before delivery resumes. The
    // goal pool does not retain the old session/UI handles across replacement.
  }

  pi.on("session_shutdown", async (event: SessionShutdownEvent, ctx: ExtensionContext) => {
    const projectRoot = canonicalProjectRoot(ctx.cwd);
    const rootSessionId = ctx.sessionManager.getSessionId();
    const logger = sessionLogger(projectRoot, rootSessionId);
    return runWithLogContext(logger, () => processWithLog(
      { operation: SESSION_OPERATIONS.STOP, parameters: { reason: event.reason } },
      async () => {
        await stopSession(event, ctx, projectRoot, rootSessionId);
      },
    ));
  });

  async function stopSession(event: SessionShutdownEvent, ctx: ExtensionContext, projectRoot: string, rootSessionId: string): Promise<void> {
    // Dispose this session's host-message gate before any further teardown: a
    // surviving retry timer could otherwise fire against the extension context
    // once the runner is invalidated, whose getters throw and would surface as
    // an uncaught exception.
    const gates = hostGateRegistry();
    const gate = gates.get(hostGateKey(projectRoot, rootSessionId));
    if (gate) {
      gate.dispose();
      gates.delete(hostGateKey(projectRoot, rootSessionId));
    }
    const pool = getChildPool(ctx.cwd, rootSessionId);
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) {
      pool.deliveryFor(pool.rootSessionIdFor(rootSessionId)).unregister(sessionFile);
    }
    // Every session owns a recursive descendant tree. A parent shutdown must
    // terminate that entire tree before the parent disappears; this applies to
    // root and child sessions and to every SDK shutdown reason (quit, new,
    // reload, fork, resume, ...). The scoped sweep prevents a child from ever
    // aborting its siblings or its parent.
    await pool.interruptRunningJobs(rootSessionId);

    // Child sessions also emit `quit` when they are disposed after settling.
    // Their descendant sweep above is the only lifecycle work they own; a child
    // must not finish root-session manifests or clear root goals.
    const isChildSession = !pool.isRootSession(rootSessionId) && !pool.shouldBootstrapRootSession(rootSessionId);
    if (isChildSession) return;

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
    // Every root host teardown pauses this root session's active goals so
    // they survive exit and are restored (still paused) when the same session
    // resumes. Other root sessions and project-level channel state remain
    // untouched. Goals are removed only when explicitly cleared via
    // goal_clear, never by session exit.
    const goalPool = getGoalPool(ctx.cwd, rootSessionId);
    goalPool.pauseAllActive(`session exited (${event.reason})`);
  }
}