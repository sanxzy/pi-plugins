import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { getChildPool } from "@xzy-ai/runtime";

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

  pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
    // Activate every registered tool so built-ins beyond the default
    // read/bash/edit/write (find, grep) are model-callable too. `ls` stays
    // excluded — the model should list files via `find`/`grep` instead.
    pi.setActiveTools(
      pi
        .getAllTools()
        .map((tool) => tool.name)
        .filter((name) => name !== "ls"),
    );

    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;

    // The root orchestrator session is not a job, but its live session id still
    // owns a session-scoped folder; the pool registers it as the scoped root so
    // the manager tree is seeded from it. Forked sessions get their own id.
    const pool = getChildPool(ctx.cwd, ctx.sessionManager.getSessionId());
    pool.registry.ensureSession(ctx.sessionManager.getSessionId());
    if (event.reason === "fork" && event.previousSessionFile) {
      // Fork creates the descendant before this event. Pending results that
      // were addressed to the replaced parent must follow that descendant.
      pool.delivery.rebind(event.previousSessionFile, sessionFile);
    }
    pool.delivery.register(sessionFile, (content) => {
      // `followUp` queues behind the active run instead of interrupting a
      // streaming response. The SDK host owns the actual parent session.
      pi.sendUserMessage(content, { deliverAs: "followUp" });
    });
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
    const isChildSession = pool.registry.get(rootSessionId) !== undefined;
    if (isChildSession) return;

    // Process quit and a confirmed `/new` both terminate the current host
    // session's background work. Reload/resume/fork preserve live children.
    if (event.reason === "quit" || event.reason === "new") {
      await pool.interruptRunningJobs(rootSessionId);
    }
  });
}