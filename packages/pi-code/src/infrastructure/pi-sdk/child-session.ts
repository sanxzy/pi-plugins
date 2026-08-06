import { join } from "node:path";
import * as PiSdk from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { isDefaultAgentName } from "../../domain/agents/default-agent.ts";
import { sessionsDir } from "../../shared/paths.ts";
import type { SpawnChildSession } from "../../domain/ports/child-session.ts";
import { observeChildStatus, type ChildStatusInput } from "./child-status.ts";

/**
 * In-process child-session adapter.
 *
 * Each child is an `AgentSession` created through `createAgentSession` with:
 * - the inherited `cwd` and `model` from the parent runtime,
 * - a fresh isolated `SessionManager`, `ModelRuntime`, and
 *   `DefaultResourceLoader` — the parent's instances are never shared, because
 *   sharing couples otherwise independent children and can overwrite extension
 *   actions,
 * - a minimal agent seam that recognizes only the inherited default agent
 *   (Phase 8 replaces it with full agent discovery).
 *
 * The supplied `AbortSignal` is forwarded to the child: an abort cancels the
 * child run through `session.abort()` and the run resolves as `aborted`.
 * Expected setup and run failures are converted into structured `ChildRunResult`
 * failures instead of throwing, mirroring the reference harness
 * (`references/pi/packages/evals/src/pi-harness.ts`).
 */

interface ChildSessionServices {
  session: AgentSession;
  dispose(): void;
}

/** Convert an unknown thrown value into a stable message string. */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve the model/auth runtime service for the child.
 *
 * The installed `@earendil-works/pi-coding-agent` exposes either a `ModelRuntime`
 * (0.80.10+) or a `ModelRegistry`/`AuthStorage` pair (0.80.2). Both are created
 * fresh for the child so isolation holds; the active service is passed to
 * `createAgentSession` under its native option name. The statics are accessed
 * through a record cast because the local type declarations only model one API
 * shape while the runtime resolves whichever the installed package provides.
 */
async function createChildModelRuntime(options: {
  agentDir: string;
}): Promise<Record<string, unknown>> {
  const sdk = PiSdk as unknown as Record<string, unknown>;
  const modelRuntime = sdk.ModelRuntime as { create?: () => Promise<unknown> } | undefined;
  if (typeof modelRuntime?.create === "function") {
    return { modelRuntime: await modelRuntime.create() };
  }

  const modelRegistry = sdk.ModelRegistry as { create?: (auth: unknown, modelsPath: string) => unknown } | undefined;
  const authStorage = sdk.AuthStorage as { create?: (authPath: string) => unknown } | undefined;
  if (typeof modelRegistry?.create === "function" && typeof authStorage?.create === "function") {
    const auth = authStorage.create(join(options.agentDir, "auth.json"));
    return {
      modelRegistry: modelRegistry.create(auth, join(options.agentDir, "models.json")),
      authStorage: auth,
    };
  }

  // Neither service is available; still let createAgentSession fall back to its
  // own defaults by returning no runtime services.
  return {};
}

/** Isolate the child's runtime stack so it never touches the parent's. */
async function createIsolatedChild(options: {
  jobId: string;
  cwd: string;
  model: unknown;
  parentSessionId?: string;
}): Promise<ChildSessionServices> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(options.cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
  });
  await resourceLoader.reload();

  const runtime = await createChildModelRuntime({ agentDir });
  const sessionManager = SessionManager.create(options.cwd, sessionsDir(options.cwd), {
    id: options.jobId,
    parentSession: options.parentSessionId,
  });

  const { session } = await (createAgentSession as unknown as (options: Record<string, unknown>) => Promise<{ session: AgentSession }>)({
    cwd: options.cwd,
    agentDir,
    model: options.model,
    ...runtime,
    settingsManager,
    sessionManager,
    resourceLoader,
  });

  return {
    session,
    dispose() {
      session.dispose();
    },
  };
}

/** Extract the final assistant text, mirroring the reference `getFinalOutput`. */
function getFinalOutput(session: AgentSession): string {
  return session.getLastAssistantText() ?? "";
}

/** Derive the child's terminal status from runtime and final assistant state. */
function deriveChildStatus(session: AgentSession): "completed" | "aborted" | "failed" {
  const state = session.agent.state;
  const lastAssistant = findLastAssistantMessage(session);
  const observed = observeChildStatus({
    isStreaming: session.isStreaming,
    stopReason: lastAssistant?.stopReason,
    errorMessage: lastAssistant?.errorMessage ?? state.errorMessage,
  } satisfies ChildStatusInput);

  // A foreground result is only returned after the settled boundary, so the
  // only non-terminal observation here is an empty session (treated as failed).
  if (observed === "aborted") return "aborted";
  if (observed === "failed" || observed === "idle" || observed === "streaming") return "failed";
  return "completed";
}

/** Find the last assistant message in the session transcript. */
function findLastAssistantMessage(session: AgentSession): {
  stopReason?: string;
  errorMessage?: string;
} | undefined {
  const messages = session.agent.state.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      return msg as { role: "assistant"; stopReason?: string; errorMessage?: string } & unknown;
    }
  }
  return undefined;
}

/**
 * Run a foreground child session to completion.
 *
 * Returns `undefined` for an unknown subagent type without spawning a child.
 */
export const spawnChildSession: SpawnChildSession = async (options) => {
  if (!isDefaultAgentName(options.subagentType)) {
    return undefined;
  }

  // A cancelled parent run must not start a child at all.
  if (options.signal?.aborted) {
    return { sessionFile: "", output: "(aborted before start)", status: "aborted" };
  }

  let child: ChildSessionServices;
  try {
    child = await createIsolatedChild({
      jobId: options.jobId,
      cwd: options.cwd,
      model: options.model,
      parentSessionId: options.parentSessionId,
    });
  } catch (error) {
    return { sessionFile: "", output: toErrorMessage(error), status: "failed" };
  }

  try {
    // The abort may have fired while the child was being created; if so the
    // child is already cancelled and there is nothing left to run.
    if (options.signal?.aborted) {
      await child.session.abort();
      return { sessionFile: child.session.sessionFile ?? "", output: "(aborted)", status: "aborted" };
    }

    let abortPromise: Promise<void> | undefined;
    const abort = () => {
      abortPromise ??= child.session.abort();
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    try {
      // prompt() resolves only after the agent run and awaited listeners settle.
      // Older PI versions do not emit the newer agent_settled session event.
      await child.session.prompt(options.prompt, {
        streamingBehavior: "steer",
        source: "extension",
      });
    } finally {
      options.signal?.removeEventListener("abort", abort);
      if (abortPromise) await abortPromise;
    }

    const sessionFile = child.session.sessionFile;
    if (!sessionFile) {
      return { sessionFile: "", output: "(no transcript)", status: "failed" };
    }

    return {
      sessionFile,
      output: getFinalOutput(child.session) || "(no output)",
      status: deriveChildStatus(child.session),
    };
  } catch (error) {
    // A run interrupted by the abort signal is reported as aborted, not failed.
    return {
      sessionFile: child.session.sessionFile ?? "",
      output: toErrorMessage(error),
      status: options.signal?.aborted ? "aborted" : "failed",
    };
  } finally {
    child.dispose();
  }
};