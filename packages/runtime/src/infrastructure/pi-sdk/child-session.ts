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
import type { ResolvedAgent } from "@xzy-ai/core";
import type { JobStatus } from "@xzy-ai/core";
import { sessionDir } from "../../shared/paths.ts";
import type {
  ChildSessionControl,
  SpawnChildSession,
} from "@xzy-ai/core";
import { observeChildStatus, type ChildStatusInput } from "./child-status.ts";
import { attachAgentSessionLiveFeed } from "./child-live.ts";
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
  liveUnsubscribe?: () => void;
  dispose(): void;
}

/** All seven Pi built-in tools; the default allowlist for child sessions. */
const ALL_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

/**
 * Map a resolved agent to its child tool allowlist.
 *
 * An explicit non-empty frontmatter `tools` list wins, except that goal
 * capabilities are always removed because goals belong to the main host. A
 * default/inherited agent or an absent/empty list enables the full built-in set
 * so the read-only Pi tools (grep, find, ls) are active by default.
 */
export function resolveChildTools(agent: ResolvedAgent): readonly string[] {
  if (agent.isDefault) return ALL_BUILTIN_TOOLS;

  const tools = agent.tools && agent.tools.length > 0 ? agent.tools : ALL_BUILTIN_TOOLS;
  return tools.filter((name) => !name.startsWith("goal_"));
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
 * A fresh call creates a new session under its parent's session folder with the
 * job id. A resume reopens the stored transcript through `SessionManager.open`,
 * which restores the header, entries, and leaf pointer from the JSONL file.
 */
async function createIsolatedChild(options: {
  jobId: string;
  cwd: string;
  model: unknown;
  agent: ResolvedAgent;
  parentSessionId: string;
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
  // A fresh child's transcript is created directly under the live session folder
  // of its parent, so the folder for `<parent-session-id>` contains exactly its
  // children's transcripts. A resumed child already lives in that folder.
  const childDir = sessionDir(options.cwd, options.parentSessionId);
  const sessionManager = options.sessionFile
    ? SessionManager.open(options.sessionFile, childDir)
    : SessionManager.create(options.cwd, childDir, {
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
  // Tool mapping: an explicit non-empty `tools` list becomes the child
  // allowlist; a default/inherited agent or an absent/empty list enables the
  // full built-in set so the read-only Pi tools (grep, find, ls) are active by
  // default.
  sessionOptions.tools = resolveChildTools(options.agent);

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
 * Reopen an existing transcript under the parent live-session folder.
 *
 * A resumed job is a NEW descendant job record whose child session reopens the
 * original job's stored session file. The copy's header id is rewritten to the
 * new job id, so the reopened session's live id matches its storage folder and
 * the original transcript stays stable and untouched. The copy lives under the
 * new job's parent live-session folder (`sessions/<parent-session-id>/`), so it
 * is discoverable and removable alongside the other children of that parent.
 */
export function copySessionFile(source: string, jobId: string, cwd: string, parentSessionId?: string): string | undefined {
  if (!source) return undefined;
  try {
    return prepareResumeSessionFile(source, jobId, cwd, parentSessionId);
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
export const spawnChildSession: SpawnChildSession & {
  /** Test seam: override isolated child construction without AI credentials. */
  __createChild?: (
    options: { jobId: string; cwd: string; model: unknown; agent: ResolvedAgent; parentSessionId: string; sessionFile?: string },
  ) => Promise<ChildSessionServices>;
} = (async (options) => {
  // A cancelled parent run must not start a child at all.
  if (options.signal?.aborted) {
    return { sessionFile: "", output: "(aborted before start)", status: "aborted" };
  }
  if (!options.parentSessionId) {
    return { sessionFile: "", output: "(no parent session id)", status: "failed" };
  }
  const parentSessionId: string = options.parentSessionId;
  const createChild = spawnChildSession.__createChild ?? ((opts) => createIsolatedChild(opts));

  return options.run(async () => {
    let child: ChildSessionServices;
    try {
      child = await createChild({
        jobId: options.jobId,
        cwd: options.cwd,
        model: options.model,
        agent: options.agent,
        parentSessionId,
        sessionFile: options.sessionFile,
      });
      const live = attachAgentSessionLiveFeed(child.session);
      options.onControl?.({
        sessionFile: child.session.sessionFile,
        live: {
          get snapshot() {
            return live.feed.snapshot;
          },
          subscribe(listener) {
            return live.feed.subscribe(listener);
          },
          steer: (prompt) => child.session.steer(prompt),
          abort: () => child.session.abort(),
        },
        steer: (prompt) => child.session.steer(prompt),
        abort: () => child.session.abort(),
      });
      (child as ChildSessionServices).liveUnsubscribe = live.unsubscribe;
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
      child.liveUnsubscribe?.();
      child.dispose();
    }
  });
}) as SpawnChildSession & {
  __createChild?: (
    options: { jobId: string; cwd: string; model: unknown; agent: ResolvedAgent; parentSessionId: string; sessionFile?: string },
  ) => Promise<ChildSessionServices>;
};

/**
 * Run a child operation under the shared per-project concurrency gate.
 *
 * The gate is owned by the pool; this adapter is the domain seam that lets the
 * `agent` tool wrap the child run in `pool.concurrency.run(...)` while keeping
 * the pool PI-SDK independent.
 */
export type ChildRunFunction = <T>(operation: () => Promise<T>) => Promise<T>;

/** Terminal statuses a child run can end in, mirrored to the registry. */
export type ChildTerminalStatus = "completed" | "aborted" | "failed";

/** Map a child result status to its registry terminal status. */
export function mapChildStatus(status: ChildTerminalStatus): JobStatus {
  return status === "completed" ? "completed" : status === "aborted" ? "cancelled" : "failed";
}