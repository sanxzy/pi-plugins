import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeSwitchEvent,
} from "@earendil-works/pi-coding-agent";
import { getChildPool, sessionTreeJobs } from "@xzy-ai/runtime";

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

export function registerLifecycleGates(pi: ExtensionAPI): void {
  pi.on("session_before_switch", async (event: SessionBeforeSwitchEvent, ctx: ExtensionContext) => {
    if (event.reason !== "new") return undefined;
    // The handler is awaited by the host before the switch and may cancel it by
    // returning `{ cancel: true }`.
    return confirmNewWithRunningJobs(event, ctx);
  });
}