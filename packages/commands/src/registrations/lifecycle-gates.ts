import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeSwitchEvent,
} from "@earendil-works/pi-coding-agent";
import { SESSION_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { getChildPool, getGoalPool, sessionTreeJobs } from "@xzy-ai/runtime";

/**
 * Ask the user to confirm `/new` when orchestrator background jobs are running.
 *
 * Called before the session switch. Returns `{ cancel: true }` to abort the
 * switch when the user declines, so running children are not orphaned without
 * consent. `/fork` is not gated: it keeps delivering results into the
 * descendant session and never kills children.
 */
async function confirmNewWithRunningJobs(
  _event: SessionBeforeSwitchEvent,
  ctx: ExtensionContext,
): Promise<{ cancel?: boolean }> {
  const rootSessionId = ctx.sessionManager.getSessionId();
  const pool = getChildPool(ctx.cwd, rootSessionId);
  const running = sessionTreeJobs(
    (jobId) => pool.registry.get(jobId),
    pool.registry.all(),
    rootSessionId,
  ).filter((job) => job.status === "running");

  // Only the active session's recursive tree participates in the `/new` gate;
  // sibling parent sessions continue running independently.
  if (running.length === 0) return {};

  if (!ctx.hasUI) {
    return { cancel: true };
  }
  const confirmed = await ctx.ui.confirm(
    "Running background agents",
    `${running.length} background agent(s) are still running. Starting a new session will stop them. Continue?`,
  );
  return { cancel: !confirmed };
}

/**
 * When a persisted active goal exists and the user is switching to a fresh
 * session, ask whether the goal should continue there. The existing running
 * jobs gate already returns a cancellation, so this handler only contributes
 * `{ cancel: true }` for the goal path; returning `{}` on a confirmed
 * continuation keeps the switch result unset (the host proceeds by default).
 */
async function confirmGoalOnSwitch(
  _event: SessionBeforeSwitchEvent,
  _ctx: ExtensionContext,
): Promise<{ cancel?: boolean }> {
  // Goals are root-session scoped. A switch creates or selects a different
  // root session and therefore cannot continue, clear, or confirm the old
  // session's goal. The old pool is stopped by its own session_shutdown.
  return { cancel: false };
}

export function registerLifecycleGates(pi: ExtensionAPI): void {
  pi.on("session_before_switch", async (event: SessionBeforeSwitchEvent, ctx: ExtensionContext) => {
    return processWithLog({ operation: SESSION_OPERATIONS.BEFORE_SWITCH, parameters: { reason: event.reason } }, async () => {
    // Both switch reasons replace the current host session. `/resume` moves to a
    // previously-persisted session; `/new` starts a fresh one. Either way a
    // persisted goal must be decided (continue or clear) and delivery suspended
    // before the switch, so the old host's timers cannot fire into a dead sink.
    if (event.reason !== "new" && event.reason !== "resume") return undefined;
    // The handler is awaited by the host before the switch and may cancel it by
    // returning `{ cancel: true }`. Running jobs gate first; the goal gate then
    // stops interval delivery until the fresh session confirms continuation.
    const jobsResult = event.reason === "new" ? await confirmNewWithRunningJobs(event, ctx) : {};
    if (jobsResult.cancel) return jobsResult;
    return confirmGoalOnSwitch(event, ctx);
    });
  });
}