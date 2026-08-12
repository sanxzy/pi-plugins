import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedAgent } from "@xzy-ai/core";
import type { Job } from "@xzy-ai/core";
import { sessionMcpBridge, sessionMcpDefinitions, sessionMcpNames, type ChildRunResult } from "@xzy-ai/core";
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
  options: { parentSessionId: string; rootSessionId?: string; parentAgentIds?: readonly string[]; sessionFile?: string; signal?: AbortSignal; useConcurrencyGate?: boolean },
): Promise<ChildRunResult | undefined> {
  const abortController = new AbortController();
  pool.jobAbortControllers?.set(job.jobId, abortController);
  options.signal?.addEventListener("abort", () => abortController.abort(), { once: true });
  try {
    return await spawnChildSession({
      jobId: job.jobId,
      cwd: ctx.cwd,
      agent,
      depth: job.depth,
      prompt: params.prompt,
      parentSessionId: options.parentSessionId,
      rootSessionId: options.rootSessionId,
      parentAgentIds: options.parentAgentIds,
      sessionFile: options.sessionFile,
      model: ctx.model,
      signal: abortController.signal,
      onControl: (control) => {
        pool.liveChildren.set(job.jobId, control);
      },
      mcpToolNames: sessionMcpNames(ctx.cwd, options.parentSessionId),
      mcpToolDefs: sessionMcpDefinitions(ctx.cwd, options.parentSessionId),
      mcpBridge: sessionMcpBridge(ctx.cwd, options.parentSessionId),
      run: (operation) => {
        if (options.useConcurrencyGate === false) {
          pool.registry.updateJob(job.jobId, { status: "running" });
          return operation();
        }
        // A job cancelled while still queued must never start. The shared gate
        // drops the queued operation when its abort signal fires.
        return pool.concurrency.runWithSignal(() => {
          pool.registry.updateJob(job.jobId, { status: "running" });
          return operation();
        }, abortController.signal);
      },
    });
  } catch (error) {
    // A parent shutdown can abort a job while it is still waiting for gate
    // admission. Convert that expected gate rejection into a terminal child
    // result instead of letting background delivery mark it as failed.
    if (abortController.signal.aborted) {
      return { sessionFile: "", output: "(aborted before start)", status: "aborted" };
    }
    throw error;
  } finally {
    // The child has settled; a later steer or cancel must not find it.
    pool.liveChildren.delete(job.jobId);
    pool.jobAbortControllers?.delete(job.jobId);
  }
}

/**
 * Run a child foreground and persist its terminal state before returning.
 *
 * Root-host calls use `runBackgroundJob`; a child/descendant call uses this
 * adapter instead so the model receives the descendant result in the same
 * tool invocation and no delivery queue or fire-and-forget task is created.
 */
export async function runForegroundAgent(
  pool: ChildPool,
  params: AgentParams,
  ctx: ExtensionContext,
  job: Job,
  agent: ResolvedAgent,
  options: { parentSessionId: string; rootSessionId?: string; parentAgentIds?: readonly string[]; parentSignal?: AbortSignal; sessionFile?: string },
): Promise<ChildRunResult> {
  const result = await spawnWithControl(pool, params, ctx, job, agent, { ...options, signal: options.parentSignal, useConcurrencyGate: false });
  const settled: ChildRunResult = result ?? {
    sessionFile: "",
    output: "could not spawn child",
    status: "failed",
  };
  const status = settled.status === "completed" ? "completed" : settled.status === "aborted" ? "cancelled" : "failed";
  // The foreground result is returned inline to the child caller, so delivery
  // is complete at call time and nothing is queued for a later drain.
  pool.registry.updateJob(job.jobId, { status, sessionFile: settled.sessionFile, delivered: true });
  return settled;
}

/** Stable job id, unique per call, eponymous with its agent directory (no prefix). */
export function makeJobId(): string {
  return Math.random().toString(36).slice(2, 8);
}
