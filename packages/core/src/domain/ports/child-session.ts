import type { ResolvedAgent } from "../agents/agent.ts";

/** Normalized terminal states exposed by a live child session. */
export type ChildLiveStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

/** A retained transcript item rendered by the manager. */
export type ChildLiveTranscriptEntry =
  | {
      readonly id: string;
      readonly kind: "message";
      readonly role: "user" | "assistant";
      readonly text: string;
      readonly complete: boolean;
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
    };

/** Normalized live event delivered to manager subscribers. */
export type ChildLiveEvent =
  | {
      readonly type: "message";
      readonly id: string;
      readonly phase: "start" | "update" | "end";
      readonly role: "user" | "assistant";
      readonly text: string;
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
    }
  | { readonly type: "agent_end"; readonly willRetry: boolean }
  | { readonly type: "settled"; readonly status: Exclude<ChildLiveStatus, "running"> };

/** Snapshot retained after a live child leaves the pool. */
export interface ChildLiveSnapshot {
  readonly status: ChildLiveStatus;
  readonly settled: boolean;
  readonly transcript: readonly ChildLiveTranscriptEntry[];
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

/** Create a feed whose snapshot remains available after all subscribers leave. */
export function createChildLiveFeed(): ChildLiveFeed {
  const listeners = new Set<(event: ChildLiveEvent) => void>();
  let snapshot: ChildLiveSnapshot = { status: "running", settled: false, transcript: [] };

  const replaceTranscript = (event: ChildLiveEvent): readonly ChildLiveTranscriptEntry[] => {
    if (event.type === "message") {
      const previous = snapshot.transcript.find((entry) => entry.id === event.id);
      const next: ChildLiveTranscriptEntry = {
        id: event.id,
        kind: "message",
        role: event.role,
        text: event.text,
        complete: event.phase === "end",
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
      if (event.type === "settled") {
        snapshot = {
          status: event.status,
          settled: true,
          transcript: snapshot.transcript,
        };
      } else {
        snapshot = { ...snapshot, transcript: replaceTranscript(event) };
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
