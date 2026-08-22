import type { ResolvedAgent } from "../agents/agent.ts";

/** Normalized terminal states exposed by a live child session. */
export type ChildLiveStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

/** A retained transcript item rendered by the manager. */
export type ChildLiveTranscriptEntry =
  | {
      readonly id: string;
      readonly kind: "message";
      readonly role: "user" | "assistant";
      /** Original SDK content blocks, retained so the host can use its native renderer. */
      readonly content?: unknown;
      /** Text-only fallback for older producers and compact activity projections. */
      readonly text: string;
      readonly complete: boolean;
      readonly stopReason?: string;
      readonly errorMessage?: string;
    }
  | {
      readonly id: string;
      readonly kind: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args?: unknown;
      readonly text: string;
      readonly complete: boolean;
      readonly isError?: boolean;
      /** Original tool result envelope, including renderer details and images. */
      readonly result?: ChildLiveToolResult;
    };

/** Renderer-compatible tool result retained in a child snapshot. */
export interface ChildLiveToolResult {
  readonly content: readonly unknown[];
  readonly details?: unknown;
  readonly isError?: boolean;
}

/** Normalized live event delivered to manager subscribers. */
export type ChildLiveEvent =
  | {
      readonly type: "message";
      readonly id: string;
      readonly phase: "start" | "update" | "end";
      readonly role: "user" | "assistant";
      /** Original SDK content blocks used by the host's native transcript renderer. */
      readonly content?: unknown;
      readonly text: string;
      readonly stopReason?: string;
      readonly errorMessage?: string;
      /** Token usage carried by the finalized assistant message; absent for user messages and partial phases. */
      readonly usage?: ChildLiveUsage;
    }
  | {
      readonly type: "tool";
      readonly id: string;
      readonly phase: "start" | "update" | "end";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args?: unknown;
      readonly text: string;
      readonly isError?: boolean;
      /** Original tool result envelope used by the host's native renderer. */
      readonly result?: ChildLiveToolResult;
    }
  | { readonly type: "context_reset" }
  | { readonly type: "agent_end"; readonly willRetry: boolean }
  | { readonly type: "settled"; readonly status: Exclude<ChildLiveStatus, "running"> };

/** Token/cost accounting reported by one finalized assistant message. */
export interface ChildLiveUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
  /** Provider-reported context size; null explicitly marks an invalid/unknown response. */
  readonly contextTokens?: number | null;
}

/** Cumulative live counters derived from the transcript and reported usage. */
export interface ChildLiveCounters {
  /** Tool executions observed so far (distinct tool call ids, started or completed). */
  readonly toolUses: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cost: number;
}

/** Snapshot retained after a live child leaves the pool. */
export interface ChildLiveSnapshot {
  readonly status: ChildLiveStatus;
  readonly settled: boolean;
  readonly transcript: readonly ChildLiveTranscriptEntry[];
  readonly counters: ChildLiveCounters;
  /** Context size for the latest finalized assistant response, not lifetime usage totals. */
  readonly contextTokens?: number;
  /** Epoch ms of the first observed event; undefined until the child starts producing activity. */
  readonly startedAtMs?: number;
}

/** Observable/control surface for one isolated child. */
export interface ChildLiveControl {
  readonly snapshot: ChildLiveSnapshot;
  subscribe(listener: (event: ChildLiveEvent) => void): () => void;
  steer(prompt: string): Promise<void>;
  abort(): Promise<void>;
}

/** Mutable in-process feed used by runtime adapters and injected test doubles. */
export interface ChildLiveFeed extends ChildLiveControl {
  emit(event: ChildLiveEvent): void;
}

function emptyCounters(): ChildLiveCounters {
  return { toolUses: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };
}

function contextTokensForUsage(usage: ChildLiveUsage): number | undefined {
  if (usage.contextTokens === null) return undefined;
  const contextTokens = usage.contextTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return contextTokens > 0 ? contextTokens : undefined;
}

/** Recompute cumulative counters from the current transcript and usage map. */
function reduceCounters(
  transcript: readonly ChildLiveTranscriptEntry[],
  usageByMessage: ReadonlyMap<string, ChildLiveUsage>,
): ChildLiveCounters {
  const toolIds = new Set<string>();
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  for (const entry of transcript) {
    if (entry.kind === "tool") toolIds.add(entry.toolCallId);
  }
  for (const usage of usageByMessage.values()) {
    input += usage.input;
    output += usage.output;
    cacheRead += usage.cacheRead;
    cacheWrite += usage.cacheWrite;
    cost += usage.cost;
  }
  return {
    toolUses: toolIds.size,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    cost,
  };
}

/** Create a feed whose snapshot remains available after all subscribers leave. */
export function createChildLiveFeed(seed?: ChildLiveSnapshot): ChildLiveFeed {
  const listeners = new Set<(event: ChildLiveEvent) => void>();
  const usageByMessage = new Map<string, ChildLiveUsage>();
  let startedAtMs: number | undefined = seed?.startedAtMs;
  const baseCounters: ChildLiveCounters = seed?.counters ?? emptyCounters();
  let snapshot: ChildLiveSnapshot = seed
    ? { status: "running", settled: false, transcript: [...seed.transcript], counters: seed.counters, ...(seed.contextTokens === undefined ? {} : { contextTokens: seed.contextTokens }), startedAtMs }
    : { status: "running", settled: false, transcript: [], counters: emptyCounters() };

  const replaceTranscript = (event: ChildLiveEvent): readonly ChildLiveTranscriptEntry[] => {
    if (event.type === "message") {
      const previous = snapshot.transcript.find((entry) => entry.id === event.id);
      const next: ChildLiveTranscriptEntry = {
        id: event.id,
        kind: "message",
        role: event.role,
        ...(event.content !== undefined ? { content: event.content } : {}),
        text: event.text,
        complete: event.phase === "end",
        ...(event.stopReason !== undefined ? { stopReason: event.stopReason } : {}),
        ...(event.errorMessage !== undefined ? { errorMessage: event.errorMessage } : {}),
      };
      if (!previous) return [...snapshot.transcript, next];
      return snapshot.transcript.map((entry) => (entry.id === event.id ? next : entry));
    }
    if (event.type === "tool") {
      const previous = snapshot.transcript.find((entry) => entry.id === event.id);
      // The end event carries no args; keep the start-time args so the final
      // entry still shows the call's parameters.
      const args = event.args !== undefined ? event.args : previous?.kind === "tool" ? previous.args : undefined;
      const next: ChildLiveTranscriptEntry = {
        id: event.id,
        kind: "tool",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args,
        text: event.text,
        complete: event.phase === "end",
        isError: event.isError,
        ...(event.result !== undefined ? { result: event.result } : {}),
      };
      if (!previous) return [...snapshot.transcript, next];
      return snapshot.transcript.map((entry) => (entry.id === event.id ? next : entry));
    }
    return snapshot.transcript;
  };

  const feed: ChildLiveFeed = {
    get snapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      if (snapshot.settled) {
        const status = snapshot.status === "running" ? "failed" : snapshot.status;
        listener({ type: "settled", status });
      }
      return () => listeners.delete(listener);
    },
    emit(event) {
      if (snapshot.settled) return;
      if (startedAtMs === undefined) startedAtMs = Date.now();
      const withBase = (raw: ChildLiveCounters): ChildLiveCounters => ({
        toolUses: raw.toolUses,
        inputTokens: baseCounters.inputTokens + raw.inputTokens,
        outputTokens: baseCounters.outputTokens + raw.outputTokens,
        cacheReadTokens: baseCounters.cacheReadTokens + raw.cacheReadTokens,
        cacheWriteTokens: baseCounters.cacheWriteTokens + raw.cacheWriteTokens,
        cost: (baseCounters.cost ?? 0) + raw.cost,
      });
      if (event.type === "context_reset") {
        snapshot = {
          ...snapshot,
          contextTokens: undefined,
          startedAtMs,
        };
      } else if (event.type === "settled") {
        const raw = reduceCounters(snapshot.transcript, usageByMessage);
        snapshot = {
          status: event.status,
          settled: true,
          transcript: snapshot.transcript,
          counters: withBase(raw),
          ...(snapshot.contextTokens === undefined ? {} : { contextTokens: snapshot.contextTokens }),
          startedAtMs,
        };
      } else if (event.type === "message" && event.usage !== undefined) {
        // The finalized assistant message is the only usage source; partial
        // updates never carry usage, so the map keyed by message id stays stable.
        usageByMessage.set(event.id, event.usage);
        const transcript = replaceTranscript(event);
        snapshot = {
          ...snapshot,
          transcript,
          counters: withBase(reduceCounters(transcript, usageByMessage)),
          contextTokens: contextTokensForUsage(event.usage),
          startedAtMs,
        };
      } else {
        const transcript = replaceTranscript(event);
        snapshot = {
          ...snapshot,
          transcript,
          counters: withBase(reduceCounters(transcript, usageByMessage)),
          startedAtMs,
        };
      }
      for (const listener of [...listeners]) listener(event);
    },
    steer: async () => {
      throw new Error("live feed is not steerable");
    },
    abort: async () => {
      throw new Error("live feed is not abortable");
    },
  };
  return feed;
}

/**
 * Child-session port.
 *
 * The application layer depends only on these functions. Infrastructure
 * implements them over the PI SDK; no SDK session handle reaches the port.
 */

/** Control surface for a live child session. */
export interface ChildSessionControl {
  /** Exact session file path, when persistence is enabled. */
  readonly sessionFile?: string;
  /** Live transcript/control surface, available once child creation has completed. */
  readonly live?: ChildLiveControl;
  /** Queue steering context for the current child run. */
  steer(prompt: string): Promise<void>;
  /** Abort the current child run and wait for it to become idle. */
  abort(): Promise<void>;
}

/** Outcome of running a foreground child session to completion. */
export interface ChildRunResult {
  /** Exact session file path written under the project session directory. */
  readonly sessionFile: string;
  /** Final assistant text, or an error message for failed/aborted runs. */
  readonly output: string;
  /** "completed" when the child finished normally, "aborted" or "failed" otherwise. */
  readonly status: "completed" | "aborted" | "failed";
}

/**
 * Spawn and run a foreground child session.
 *
 * The child uses the inherited `cwd` and `model` with a fresh isolated
 * `SessionManager`/`ModelRuntime`/`DefaultResourceLoader`. The subagent type is
 * resolved by the application layer; an unknown name never reaches this port.
 */
export type SpawnChildSession = (options: {
  /** Stable orchestrator job id, used as the child session id for new sessions. */
  jobId: string;
  /** Working directory inherited from the parent session. */
  cwd: string;
  /** Resolved agent definition loaded from an agent file. */
  agent: ResolvedAgent;
  /** Lineage depth of this child; depth 4 is the terminal recursive leaf. */
  depth?: number;
  /** Instruction to run in the child session. */
  prompt: string;
  /** Parent session id, preserved in the child session header. */
  parentSessionId?: string;
  /** Root Pi session id owning the home-scoped agent tree. */
  rootSessionId?: string;
  /** Parent agent ids for nested home-scoped agent directories. */
  parentAgentIds?: readonly string[];
  /** Stored transcript to reopen for a resume, if any. */
  sessionFile?: string;
  /** Model-facing MCP names discovered by the owning parent session. */
  mcpToolNames?: readonly string[];
  /** MCP tool definitions registered by the parent's MCP lifecycle, for child inheritance. */
  mcpToolDefs?: ReadonlyArray<{ name: string; description: string; parameters: unknown }>;
  /** Whether the parent session has an active MCP server; hides the empty surface when false. */
  mcpEnabled?: boolean;
  /** Process-local bridge used by inherited dynamic MCP tools/resources. */
  mcpBridge?: {
    invokeTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
    listResources(server: string): unknown;
    readResource(server: string, uri: string, signal?: AbortSignal): Promise<unknown>;
  };
  /** Abort signal forwarded to the child's run and concurrency wait. */
  signal?: AbortSignal;
  /** Called once the isolated child exists and can be controlled. */
  onControl?: (control: ChildSessionControl) => void;
  /**
   * Model inherited from the parent session.
   *
   * Opaque to the domain: the infrastructure adapter narrows it to the SDK
   * model type at the boundary. The tool guarantees this is defined before
   * calling the port.
   */
  model: unknown;
  /**
   * Run the child under the shared per-project concurrency gate.
   *
   * The gate is owned by the pool, so the domain only needs a function that
   * runs the given operation while holding a slot. The registry records
   * `running` at the moment the slot is acquired. The optional signal lets the
   * gate observe cancellations that arrive while the job is queued.
   */
  run: (
    operation: () => Promise<ChildRunResult | undefined>,
    signal?: AbortSignal,
  ) => Promise<ChildRunResult | undefined>;
}) => Promise<ChildRunResult | undefined>;
