import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ControlCaller } from "@xzy-ai/core";
import type { ChildPool } from "@xzy-ai/runtime";

/**
 * The caller's own control view.
 *
 * The caller's job id is its child session id when that session is itself a
 * registered job; the root orchestrator session is not a job, so it controls
 * and views every job in the project.
 */
export function callerFor(ctx: ExtensionContext, pool: ChildPool): ControlCaller {
  const sessionId = ctx.sessionManager.getSessionId();
  return { jobId: pool.registry.get(sessionId) ? sessionId : undefined };
}
