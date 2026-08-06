import { join } from "node:path";
import * as PiSdk from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedAgent } from "../../domain/agents/agent.ts";
import type { JobStatus } from "../../domain/jobs/status.ts";
import { sessionsDir } from "../../shared/paths.ts";
import type {
  ChildSessionControl,
  SpawnChildSession,
} from "../../domain/ports/child-session.ts";
import { observeChildStatus, type ChildStatusInput } from "./child-status.ts";
import { prepareResumeSessionFile } from "../sessions/resume-file.ts";

/**
 * In-process child-session adapter.
 *
 * Each child is an `AgentSession` created through `createAgentSession` with:
 * - the inherited `cwd` and `model` from the parent runtime,
 * - a fresh isolated `SessionManager`, `ModelRuntime`, and
 *   `DefaultResourceLoader` — the parent's instances are never shared, because
 *   sharing couples otherwise independent children and can overwrite extension
 *   actions,
 * - a resolved agent definition that can provide a stable system-prompt
 *   override, a tool allowlist, and a model override.
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
}): Promise<{ runtime: Record<string, unknown>; modelRuntime?: ModelRuntime }> {
  const sdk = PiSdk as unknown as Record<string, unknown>;
  const modelRuntime = sdk.ModelRuntime as {
    create?: () => Promise<unknown>;
  } | undefined;
  if (typeof modelRuntime?.create === "function") {
    const instance = (await modelRuntime.create()) as ModelRuntime;
    return { runtime: { modelRuntime: instance }, modelRuntime: instance };
  }

  const modelRegistry = sdk.ModelRegistry as { create?: (auth: unknown, modelsPath: string) => unknown } | undefined;
  const authStorage = sdk.AuthStorage as { create?: (authPath: string) => unknown } | undefined;
  if (typeof modelRegistry?.create === "function" && typeof authStorage?.create === "function") {
    const auth = authStorage.create(join(options.agentDir, "auth.json"));
    return {
      runtime: {
        modelRegistry: modelRegistry.create(auth, join(options.agentDir, "models.json")),
        authStorage: auth,
      },
    };
  }

  // Neither service is available; still let createAgentSession fall back to its
  // own defaults by returning no runtime services.
  return { runtime: {} };
}

/**
 * Isolate the child's runtime stack so it never touches the parent's.
 *
 * A fresh call creates a new session under the project session directory with
 * the job id. A resume reopens the stored transcript through `SessionManager.open`,
 * which restores the header, entries, and leaf pointer from the JSONL file.
 */
async function createIsolatedChild(options: {
  jobId: string;
  cwd: string;
  model: unknown;
  agent: ResolvedAgent;
  parentSessionId?: string;
  sessionFile?: string;
}): Promise<ChildSessionServices> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(options.cwd, agentDir);
  // The discovered agent carries the frontmatter fields and Markdown body; the
  // inherited default agent carries none of them.
  const discovered = options.agent.isDefault === false ? options.agent : undefined;
  // The agent Markdown body is applied through a stable system-prompt override
  // on the child's own loader. `reload()` re-applies the override on every
  // rebuild, so the prompt survives a runtime resource reload (a one-time
  // mutation would be reset).
  const systemPromptOverride = discovered ? () => discovered.systemPrompt : undefined;
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    systemPromptOverride,
  });
  await resourceLoader.reload();

  const { runtime, modelRuntime } = await createChildModelRuntime({ agentDir });
  const sessionManager = options.sessionFile
    ? SessionManager.open(options.sessionFile, sessionsDir(options.cwd))
    : SessionManager.create(options.cwd, sessionsDir(options.cwd), {
        id: options.jobId,
        parentSession: options.parentSessionId,
      });

  // Model mapping: an explicit frontmatter model is resolved against the child
  // runtime and falls back to the inherited parent model when resolution fails
  // or no runtime/models are available; an absent model inherits the parent.
  const model =
    discovered && discovered.model ? resolveChildModel(discovered.model, modelRuntime) ?? options.model : options.model;

  const sessionOptions: Record<string, unknown> = {
    cwd: options.cwd,
    agentDir,
    model,
    ...runtime,
    settingsManager,
    sessionManager,
    resourceLoader,
  };
  // Tool mapping: an explicit `tools` list becomes the child allowlist; an
  // absent list leaves the child on the SDK's default tools.
  if (discovered && discovered.tools) {
    sessionOptions.tools = discovered.tools;
  }

  const { session } = await (createAgentSession as unknown as (options: Record<string, unknown>) => Promise<{ session: AgentSession }>)(sessionOptions);

  return {
    session,
    dispose() {
      session.dispose();
    },
  };
}

/**
 * Resolve a frontmatter model reference against the child model runtime.
 *
 * Returns the resolved model, or `undefined` when there is no runtime, no
 * configured models, or the reference does not match. The caller falls back to
 * the inherited parent model in every failure case.
 */
function resolveChildModel(model: string, modelRuntime: ModelRuntime | undefined): unknown {
  if (!modelRuntime) return undefined;
  const result = resolveCliModel({ cliModel: model, modelRuntime });
  return result.model;
}

/**
 * Reopen an existing transcript under the project session directory.
 *
 * A resumed job is a NEW descendant job record whose child session reopens the
 * original job's stored session file. Because the reopened session keeps the
 * original session id, on-disk transcript and in-memory child session it is
 * played through a fresh copy so the original transcript stays stable and the
 * resumed run never mutates it. The copy lives under the project session
 * directory so it is discoverable and removable alongside the other children.
 */
export function copySessionFile(source: string, jobId: string, cwd: string): string | undefined {
  if (!source) return undefined;
  try {
    return prepareResumeSessionFile(source, jobId, cwd);
  } catch {
    return undefined;
  }
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
 * The whole child lifecycle (create + prompt) runs under the shared concurrency
 * gate. Admission is recorded as `queued → running` by the composition root at
 * the exact moment the slot is acquired, so every failure after admission is a
 * legal `running → failed` transition. A parent run that is already aborted
 * before admission never enters the gate and the job stays `queued` (the
 * composition root marks it `cancelled` from the aborted result).
 */
export const spawnChildSession: SpawnChildSession = async (options) => {
  // A cancelled parent run must not start a child at all.
  if (options.signal?.aborted) {
    return { sessionFile: "", output: "(aborted before start)", status: "aborted" };
  }

  return options.run(async () => {
    let child: ChildSessionServices;
    try {
      child = await createIsolatedChild({
        jobId: options.jobId,
        cwd: options.cwd,
        model: options.model,
        agent: options.agent,
        parentSessionId: options.parentSessionId,
        sessionFile: options.sessionFile,
      });
      options.onControl?.({
        sessionFile: child.session.sessionFile,
        steer: (prompt) => child.session.steer(prompt),
        abort: () => child.session.abort(),
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
  });
};

/**
 * Run a child operation under the shared per-project concurrency gate.
 *
 * The gate is owned by the pool; this adapter is the domain seam that lets the
 * `task` tool wrap the child run in `pool.concurrency.run(...)` while keeping
 * the pool PI-SDK independent.
 */
export type ChildRunFunction = <T>(operation: () => Promise<T>) => Promise<T>;

/** Terminal statuses a child run can end in, mirrored to the registry. */
export type ChildTerminalStatus = "completed" | "aborted" | "failed";

/** Map a child result status to its registry terminal status. */
export function mapChildStatus(status: ChildTerminalStatus): JobStatus {
  return status === "completed" ? "completed" : status === "aborted" ? "cancelled" : "failed";
}