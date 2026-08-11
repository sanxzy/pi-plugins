import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedAgent } from "@xzy-ai/core";
import type { Job } from "@xzy-ai/core";
import { sessionMcpNames, type ChildRunResult } from "@xzy-ai/core";
import { getChildPool, type ChildPool } from "@xzy-ai/runtime";
import { spawnChildSession } from "@xzy-ai/runtime";
import type { AgentParams } from "./tools.ts";

/**
 * Spawn a child for a new or resumed job under the shared gate.
 *
 * The live-child handle is registered before the child exists so a steer or
 * cancel issued while the child is still creating finds the job; it is removed
 * once the child settles. The `queued → running` transition is recorded at the
 * exact moment the gate slot is acquired.
 */
export async function spawnWithControl(
  pool: ChildPool,
  params: AgentParams,
  ctx: ExtensionContext,
  job: Job,
  agent: ResolvedAgent,
  options: { parentSessionId: string; rootSessionId?: string; parentAgentIds?: readonly string[]; sessionFile?: string; signal?: AbortSignal },
): Promise<ChildRunResult | undefined> {
  try {
    return await spawnChildSession({
      jobId: job.jobId,
      cwd: ctx.cwd,
      agent,
      prompt: params.prompt,
      parentSessionId: options.parentSessionId,
      rootSessionId: options.rootSessionId,
      parentAgentIds: options.parentAgentIds,
      sessionFile: options.sessionFile,
      model: ctx.model,
      signal: options.signal,
      onControl: (control) => {
        pool.liveChildren.set(job.jobId, control);
      },
      mcpToolNames: sessionMcpNames(ctx.cwd, options.parentSessionId),
      run: (operation) =>
        pool.concurrency.run(() => {
          pool.registry.updateJob(job.jobId, { status: "running" });
          return operation();
        }),
    });
  } finally {
    // The child has settled; a later steer or cancel must not find it.
    pool.liveChildren.delete(job.jobId);
  }
}

/** Stable job id, unique per call, eponymous with its agent directory (no prefix). */
export function makeJobId(): string {
  return Math.random().toString(36).slice(2, 8);
}
