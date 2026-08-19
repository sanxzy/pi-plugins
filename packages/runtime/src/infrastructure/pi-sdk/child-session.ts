import { join } from "node:path";
import * as PiSdk from "@earendil-works/pi-coding-agent";
import { maxAgentDepth } from "../../shared/pi-c2-config.ts";
import { initializeChildPonytailState } from "../ponytail/state.ts";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { resolveChildModelMapping, resolveChildThinkingMapping } from "./child-model.ts";
import { resolveSettingsForProject, settingsConfigPath } from "../../shared/settings.ts";
import type { ResolvedAgent } from "@xzy-ai/core";
import type { JobStatus } from "@xzy-ai/core";
import { publishSessionMcpActive, publishSessionMcpBridge, publishSessionMcpDefinitions, publishSessionMcpNames, clearMcpNames } from "@xzy-ai/core";
import { childSessionPaths, ensurePrivateDirectory, sessionDir } from "../../shared/paths.ts";
import type {
  ChildSessionControl,
  SpawnChildSession,
} from "@xzy-ai/core";
import { AGENT_OPERATIONS, MCP_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { observeChildStatus, type ChildStatusInput } from "./child-status.ts";
import { attachAgentSessionLiveFeed } from "./child-live.ts";
import { getChildPool } from "../pool/child-pool.ts";
import { getChildExtensionFactories, getChildPonytailTools, type ChildPonytailTools } from "./child-extensions.ts";
import { inheritedMcpRenderCall, inheritedMcpRenderResult } from "./render-safe.ts";

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

/** All Pi built-in tools allowed to children; `ls` is excluded by policy (the model must list files via `find`/`grep`). */
const ALL_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find"] as const;

/**
 * pi-c2 extension tools appended to child allowlists. Depths below the
 * configured max receive the agent-family and web tools so they can recurse;
 * the terminal leaf keeps the web/wiki family but cannot spawn or manage
 * another agent. Goal and Telegram capabilities stay root-only; MCP resource
 * tools are allowed so every descendant can inspect the inherited MCP catalog.
 */
const AGENT_FAMILY_TOOLS = [
  "agent",
  "agent_list",
  "agent_jobs",
  "agent_status",
  "agent_cancel",
] as const;
const WEB_FAMILY_TOOLS = ["web_search", "web_fetch", "knowledge_search"] as const;
const PONYTAIL_TOOL = "create_write_edit_ticket";
/** Dedicated ticket-free Markdown/Text tools, appended only when Ponytail is enabled. */
const MARKDOWN_TOOLS = ["write_markdown", "edit_markdown"] as const;
const EXTENSION_TOOLS = [...AGENT_FAMILY_TOOLS, ...WEB_FAMILY_TOOLS] as const;

/** MCP resource/prompt tools every child may expose so subagents can manage MCP. */
const MCP_RESOURCE_TOOLS = [
  "mcp_resources_list",
  "mcp_resources_read",
] as const;

/**
 * Compose the child session's `customTools` list.
 *
 * Inherited MCP definitions are always included when the bridge is enabled and
 * definitions are supplied. The Ponytail `write`/`edit` wrapper definitions are
 * appended ONLY when the child's effective Ponytail state is enabled and the
 * definitions were published by the composition root; when Ponytail is
 * disabled the child uses the normal built-in `write`/`edit` tools and no
 * wrapper is injected.
 */
export function resolveChildCustomTools(options: {
  mcpToolDefs?: ReadonlyArray<{ name: string; description: string; parameters: unknown }>;
  mcpEnabled?: boolean;
  mcpBridge?: {
    invokeTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
    listResources(server: string): unknown;
    readResource(server: string, uri: string, signal?: AbortSignal): Promise<unknown>;
  };
  ponytailEnabled: boolean;
  ponytailTools?: ChildPonytailTools;
}): Array<{ name: string; label: string; description: string; parameters: unknown; execute: (id: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> }> {
  const customTools: Array<{ name: string; label: string; description: string; parameters: unknown; execute: (id: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> }> = [];
  if (options.mcpToolDefs?.length && options.mcpEnabled !== false && options.mcpBridge) {
    customTools.push(...options.mcpToolDefs.map((definition) => ({
      name: definition.name,
      label: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      execute: async (_id: string, args: Record<string, unknown>, signal: AbortSignal | undefined) => processWithLog({
        operation: MCP_OPERATIONS.INVOKE_TOOL,
        parameters: { name: definition.name, args },
      }, async () => options.mcpBridge
        ? await options.mcpBridge.invokeTool(definition.name, args, signal)
        : { content: [{ type: "text", text: "Inherited MCP execution bridge is unavailable" }], details: { error: "mcp bridge unavailable" } }),
      renderCall: (args: unknown, theme: { fg(color: string, text: string): string; bold(text: string): string }, context: { expanded?: boolean; args?: unknown }) => inheritedMcpRenderCall(definition.name, definition.name, theme, { ...context, args }),
      renderResult: (result: unknown, renderOptions: { expanded?: boolean; isPartial: boolean }, theme: { fg(color: string, text: string): string }, context: { isError?: boolean }) => inheritedMcpRenderResult(result, renderOptions, theme, context),
    })));
  }
  if (options.ponytailEnabled && options.ponytailTools) {
    customTools.push(
      options.ponytailTools.write as unknown as { name: string; label: string; description: string; parameters: unknown; execute: (id: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> },
      options.ponytailTools.edit as unknown as { name: string; label: string; description: string; parameters: unknown; execute: (id: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> },
    );
  }
  return customTools;
}

/**
 * Map a resolved agent to its child tool allowlist.
 *
 * An explicit non-empty frontmatter `tools` list wins, except that goal and
 * Telegram capabilities are always stripped because they belong to the main
 * host. An absent/empty list enables the full built-in set (minus `ls`) plus
 * the session-scoped MCP catalog. Depths below the configured max depth receive
 * the pi-c2 agent-family and web tools so they can recurse; the terminal
 * leaf keeps only the web/wiki family. MCP resource tools and the discovered
 * MCP catalog remain available at every depth. The `mcp` slash command is not
 * a model tool and is excluded from the allowlist.
 */
const ROOT_ONLY_TOOLS = new Set([
  "goal_create", "goal_pause", "goal_resume", "goal_status", "goal_clear",
  "telegram_chat",
  // `/mcp` is a host command, not an MCP model tool; discovered MCP tools and
  // the two resource tools above remain available to children.
  "mcp",
]);

/** Resolve child tools against the session-local discovered MCP catalog. */
export function resolveChildTools(
  agent: ResolvedAgent,
  mcpToolNames: readonly string[] = [],
  depth = 0,
  cwd?: string,
  mcpEnabled = true,
  ponytailEnabled = false,
): readonly string[] {
  const requested = agent.tools && agent.tools.length > 0 ? [...agent.tools] : [...ALL_BUILTIN_TOOLS];
  const extensionNames = EXTENSION_TOOLS as readonly string[];
  const markdownNames = ponytailEnabled ? (MARKDOWN_TOOLS as readonly string[]) : [];
  const builtinNames = new Set<string>(ALL_BUILTIN_TOOLS);
  const mcpNames = new Set(mcpToolNames);
  const filtered = requested.filter((name) =>
    !name.startsWith("goal_") &&
    !ROOT_ONLY_TOOLS.has(name) &&
    (builtinNames.has(name) || extensionNames.includes(name) || mcpNames.has(name)),
  );
  // The configured max depth is the final recursive leaf. It keeps research
  // and MCP access, but cannot create another descendant or inspect/cancel
  // the agent family.
  const extensionTools = depth >= maxAgentDepth(cwd) ? WEB_FAMILY_TOOLS : EXTENSION_TOOLS;
  return [...new Set([
    ...filtered.filter((name) => !extensionNames.includes(name)),
    ...extensionTools,
    ...(mcpEnabled ? MCP_RESOURCE_TOOLS : []),
    ...(mcpEnabled ? mcpToolNames : []),
    ...(ponytailEnabled ? [PONYTAIL_TOOL] : []),
    ...markdownNames,
  ])];
}

/** Convert an unknown thrown value into a stable message string. */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve the model/auth runtime service for the child.
 *
 * The installed `@earendil-works/pi-coding-agent` exposes either a `ModelRuntime`
 * (0.84.1+) or a `ModelRegistry`/`AuthStorage` pair from older releases. Both are created
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
  depth?: number;
  parentSessionId: string;
  rootSessionId?: string;
  parentAgentIds?: readonly string[];
  sessionFile?: string;
  mcpToolNames?: readonly string[];
  mcpToolDefs?: ReadonlyArray<{ name: string; description: string; parameters: unknown }>;
  mcpEnabled?: boolean;
  mcpBridge?: {
    invokeTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
    listResources(server: string): unknown;
    readResource(server: string, uri: string, signal?: AbortSignal): Promise<unknown>;
  };
}): Promise<ChildSessionServices> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(options.cwd, agentDir);
  // The percentage-based auto-compaction threshold from the pi-c2 home
  // config.json applies to every child session at any depth. It is applied as
  // an in-memory override on the child's own SettingsManager so the SDK-native
  // `_checkCompaction` path (the only auto-compaction that runs inside child
  // sessions, since children never emit extension events) uses the configured
  // percentage instead of the default reserve-token math.
  settingsManager.setCompactionThresholdPercent(resolveSettingsForProject(options.cwd).runtime.contextCompactThresholdPercent);
  // Every resolved agent comes from a valid agent file and carries its
  // frontmatter fields and Markdown body.
  const discovered = options.agent;
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
    // Isolated child loaders inherit the inline extension factories that the
    // host loaded (e.g. `pi -e plugins/packages/pi-c2/index.ts`), so the
    // agent-family and research tools registered by the pi-c2 composition
    // root are constructible in the child. The allowlist still decides which
    // of those tools are active; goal/MCP capabilities remain root-only.
    extensionFactories: getChildExtensionFactories(),
  });
  await resourceLoader.reload();

  const { runtime, modelRuntime } = await createChildModelRuntime({ agentDir });
  // Flush extension-registered providers (e.g. the `commandcode` provider
  // installed via settings packages) into the isolated child runtime so
  // frontmatter `model: commandcode/...` resolves instead of falling back
  // to the parent model. Mirrors `createAgentSessionServices` in the SDK.
  if (modelRuntime) {
    const extensionsResult = resourceLoader.getExtensions() as unknown as {
      runtime: {
        pendingProviderRegistrations: Array<{ name: string; config: unknown }>;
        pendingNativeProviderRegistrations: Array<{ provider: unknown }>;
      };
    };
    for (const { name, config } of extensionsResult.runtime.pendingProviderRegistrations ?? []) {
      try {
        (modelRuntime as unknown as { registerProvider(name: string, config: unknown): void }).registerProvider(name, config);
      } catch {
        // Provider composition errors are surfaced via diagnostics; do not
        // abort child creation for one bad extension.
      }
    }
    for (const { provider } of extensionsResult.runtime.pendingNativeProviderRegistrations ?? []) {
      try {
        (modelRuntime as unknown as { registerNativeProvider(provider: unknown): void }).registerNativeProvider(provider);
      } catch {
        // Same: keep the child alive on native-provider errors.
      }
    }
    extensionsResult.runtime.pendingProviderRegistrations = [];
    extensionsResult.runtime.pendingNativeProviderRegistrations = [];
    try {
      await (modelRuntime as unknown as { refresh(opts?: unknown): Promise<unknown> }).refresh({ allowNetwork: false });
    } catch {
      // Availability refresh is best-effort; resolution can still proceed
      // against `getModels()` even if availability checks fail.
    }
  }
  const sessionManager = createChildSessionManager({
    cwd: options.cwd,
    jobId: options.jobId,
    parentSessionId: options.parentSessionId,
    rootSessionId: options.rootSessionId,
    parentAgentIds: options.parentAgentIds,
    sessionFile: options.sessionFile,
  });
  const childContext = { cwd: options.cwd, sessionManager };
  const childPonytailEnabled = options.rootSessionId
    ? initializeChildPonytailState(options.rootSessionId, options.jobId)
    : false;
  // Publish the inherited MCP catalog under this child session id so its own
  // foreground descendants can inherit it recursively.
  publishSessionMcpNames(childContext, options.mcpEnabled === false ? [] : options.mcpToolNames ?? []);
  publishSessionMcpActive(childContext, options.mcpEnabled !== false);
  publishSessionMcpDefinitions(childContext, options.mcpToolDefs ?? []);
  if (options.mcpBridge) publishSessionMcpBridge(childContext, options.mcpBridge);

  // Model mapping, in resolution priority: frontmatter `model` (exact
  // contract) > `agents.model` in the home-root `pi-c2/config.json` (exact
  // contract) > parent model. When a configured value is present it is
  // accepted exactly as-is and must resolve against the child catalog — an
  // unresolvable reference fails the child with a clear message instead of
  // silently falling back to the parent model. Only an absent value at both
  // levels inherits the parent model.
  let model = options.model;
  const mapping = resolveChildModelMapping({
    frontmatterModel: discovered?.model,
    globalModel: resolveSettingsForProject(options.cwd).agents.model,
    agentName: discovered?.name ?? "",
    modelRuntime,
    globalConfigPath: settingsConfigPath(),
  });
  if (mapping.error) {
    throw new Error(mapping.error);
  }
  if (mapping.model) {
    model = mapping.model;
  }

  const sessionOptions: Record<string, unknown> = {
    cwd: options.cwd,
    agentDir,
    model,
    ...runtime,
    settingsManager,
    sessionManager,
    resourceLoader,
  };
  // Thinking mapping, in resolution priority: frontmatter `thinking` (exact)
  // > `agents.thinking` in the home-root `pi-c2/config.json` (exact) > SDK
  // default. A configured level is applied as-is; an invalid global level
  // fails the child with a clear error instead of silently ignoring it. The
  // SDK clamps unsupported levels to the model's range.
  const thinking = resolveChildThinkingMapping({
    frontmatterThinking: discovered?.thinking,
    globalThinking: resolveSettingsForProject(options.cwd).agents.thinking,
    globalConfigPath: settingsConfigPath(),
  });
  if (thinking.error) {
    throw new Error(thinking.error);
  }
  if (thinking.thinking) {
    sessionOptions.thinkingLevel = thinking.thinking;
  }
  // Tool mapping: an explicit non-empty `tools` list becomes the child
  // allowlist; an absent/empty list enables the full built-in set (excluding
  // `ls`) plus the depth-aware extension/MCP policy.
  sessionOptions.tools = resolveChildTools(options.agent, options.mcpToolNames, options.depth, options.cwd, options.mcpEnabled ?? true, childPonytailEnabled);
  sessionOptions.mcpToolNames = options.mcpEnabled === false ? [] : options.mcpToolNames ?? [];
  // Dynamic MCP definitions are supplied by the parent composition root. The
  // child loader cannot discover the parent's MCP manager, so register the
  // inherited definitions as isolated local tools whose execution is routed
  // through the parent's stable MCP tool bridge. When the child's effective
  // Ponytail state is enabled, the Ponytail `write`/`edit` wrapper definitions
  // (published by the composition root) are appended so the child enforces the
  // same required-ticket boundary as a root session; when disabled, no wrapper
  // is injected and the child uses the normal built-in tools.
  const childCustomTools = resolveChildCustomTools({
    mcpToolDefs: options.mcpToolDefs,
    mcpEnabled: options.mcpEnabled,
    mcpBridge: options.mcpBridge,
    ponytailEnabled: childPonytailEnabled,
    ponytailTools: getChildPonytailTools(),
  });
  if (childCustomTools.length > 0) {
    sessionOptions.customTools = childCustomTools;
  }

  const { session } = await (createAgentSession as unknown as (options: Record<string, unknown>) => Promise<{ session: AgentSession }>)(sessionOptions);

  return {
    session,
    dispose() {
      clearMcpNames(childContext);
      session.dispose();
    },
  };
}

/**
 * Resolve the isolated child's `SessionManager` for a fresh or resumed child.
 *
 * When a root-session boundary is supplied the manager writes its transcript to
 * the deterministic home-scoped agent location; otherwise it falls back to the
 * legacy project-local session folder. This keeps the adapter testable without
 * AI credentials while mirroring exactly what `createIsolatedChild` does.
 */
export function createChildSessionManager(options: {
  cwd: string;
  jobId: string;
  parentSessionId: string;
  rootSessionId?: string;
  parentAgentIds?: readonly string[];
  sessionFile?: string;
}): SessionManager {
  const storage = options.rootSessionId
    ? childSessionPaths({ cwd: options.cwd, rootSessionId: options.rootSessionId, jobId: options.jobId, parentAgentIds: options.parentAgentIds })
    : undefined;
  const childDir = storage?.agentDir ?? sessionDir(options.cwd, options.parentSessionId);
  if (storage) ensurePrivateDirectory(childDir);
  return options.sessionFile
    ? SessionManager.open(options.sessionFile, childDir)
    : SessionManager.create(options.cwd, childDir, {
        id: options.jobId,
        parentSession: options.parentSessionId,
        ...(storage ? { sessionFilename: "transcript.jsonl", privateRoot: storage.projectDir } : {}),
      });
}

/** Extract the final assistant text, mirroring the reference `getFinalOutput`. */
function getFinalOutput(session: AgentSession): string {
  const lastAssistant = findLastAssistantMessage(session);
  if (lastAssistant?.errorMessage) return lastAssistant.errorMessage;
  const stateError = (session.agent.state as { errorMessage?: string }).errorMessage;
  if (stateError) return stateError;
  const viaSdk = session.getLastAssistantText();
  if (viaSdk) return viaSdk;
  // Fallback scan for compacted histories where the SDK helper filters the last message.
  const messages = session.agent.state.messages as readonly { role?: string; content?: unknown }[];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    const text = messageContentText(msg);
    if (text) return text;
  }
  return "";
}

function messageContentText(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return (message.content as unknown[])
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const value = part as { type?: unknown; text?: unknown; name?: unknown };
      if (value.type === "text" && typeof value.text === "string") return value.text;
      if (value.type === "toolCall" && typeof value.name === "string") return value.name;
      return "";
    })
    .join("")
    .trim();
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
    options: { jobId: string; cwd: string; model: unknown; agent: ResolvedAgent; depth?: number; parentSessionId: string; rootSessionId?: string; parentAgentIds?: readonly string[]; sessionFile?: string; mcpToolNames?: readonly string[]; mcpToolDefs?: ReadonlyArray<{ name: string; description: string; parameters: unknown }>; mcpEnabled?: boolean; mcpBridge?: { invokeTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>; listResources(server: string): unknown; readResource(server: string, uri: string, signal?: AbortSignal): Promise<unknown> }; },
  ) => Promise<ChildSessionServices>;
} = (async (options) => {
  // Wrap the whole foreground child lifecycle as one correlated boundary.
  return processWithLog({ operation: AGENT_OPERATIONS.LIFECYCLE, parameters: { jobId: options.jobId } }, async () => {
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
        depth: options.depth,
        parentSessionId,
        rootSessionId: options.rootSessionId,
        parentAgentIds: options.parentAgentIds,
        sessionFile: options.sessionFile,
        mcpToolNames: options.mcpToolNames,
        mcpToolDefs: options.mcpToolDefs,
        mcpEnabled: options.mcpEnabled,
        mcpBridge: options.mcpBridge,
      });
      const retained = getChildPool(options.cwd).retainedLiveSnapshots?.get(options.jobId);
      const live = attachAgentSessionLiveFeed(child.session, retained);
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
  }, options.signal);
  });
}) as SpawnChildSession & {
  __createChild?: (
    options: { jobId: string; cwd: string; model: unknown; agent: ResolvedAgent; depth?: number; parentSessionId: string; rootSessionId?: string; parentAgentIds?: readonly string[]; sessionFile?: string; mcpToolNames?: readonly string[]; mcpEnabled?: boolean },
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