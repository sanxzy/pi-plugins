import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ControlCaller } from "@xzy-ai/core";
import type { ChildPool } from "@xzy-ai/runtime";

/**
 * The caller's own control view.
 *
 * The live session id bounds every caller to its own parent-session tree. A
 * nested child also carries its registered job id and root lineage so the core
 * control rules can preserve recursive descendant management.
 */
export function callerFor(ctx: ExtensionContext, pool: ChildPool): ControlCaller {
  const sessionId = ctx.sessionManager.getSessionId();
  const job = pool.registry.get(sessionId);
  return {
    sessionId,
    jobId: job ? sessionId : undefined,
    rootJobId: job?.rootJobId,
  };
}
