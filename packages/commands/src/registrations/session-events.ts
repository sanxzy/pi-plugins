import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { getChildPool, getGoalPool, type GoalDeliveryBinding } from "@xzy-ai/runtime";

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
    // Activate every registered tool so built-ins beyond the default
    // read/bash/edit/write (find, grep) are model-callable too. `ls` stays
    // excluded — the model should list files via `find`/`grep` instead.
    pi.setActiveTools(
      pi
        .getAllTools()
        .map((tool) => tool.name)
        .filter((name) => name !== "ls"),
    );

    // Bind the goal pool to the fresh host. On a fresh session the prior host
    // is gone; delivery may resume only after the user confirms continuation.
    const goalPool = getGoalPool(ctx.cwd);
    goalPool.bind(goalBinding(pi, ctx));

    // Goal confirmation must run even for an unpersisted host session, because
    // the goal record is independent of the child-session delivery registry.
    // A Continue decision made by session_before_switch belongs to this fresh
    // host. Consume it before checking startup-like reasons so `/resume` does
    // not ask the user twice after the switch has already been authorized.
    if (goalPool.takeReplacementContinuation()) {
      goalPool.resumeDelivery();
    } else if (event.reason === "startup" || event.reason === "resume" || event.reason === "reload") {
      if (ctx.hasUI && goalPool.beginSessionConfirmation()) {
        const continueGoal = await ctx.ui.confirm(
          "Persisted goal",
          "A persisted active goal still exists. Continue it in this session? Choose Cancel to clear it.",
        );
        if (continueGoal) {
          goalPool.resumeDelivery();
        } else {
          goalPool.clearActiveGoals();
        }
      } else if (!ctx.hasUI) {
        goalPool.beginSessionConfirmation();
      } else {
        goalPool.resumeDelivery();
      }
    } else {
      goalPool.resumeDelivery();
    }

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
    const isChildSession = pool.registry.get(rootSessionId) !== undefined;
    if (isChildSession) return;

    // Process quit and a confirmed `/new` both terminate the current host
    // session's background work. Reload/resume/fork preserve live children.
    if (event.reason === "quit" || event.reason === "new") {
      await pool.interruptRunningJobs(rootSessionId);
    }
    // Every root host teardown must stop goal timers and detach delivery. The
    // persisted goal remains in the append-only store for the replacement host
    // to confirm; child-session ownership is already isolated above.
    getGoalPool(ctx.cwd).shutdown();
  });
}