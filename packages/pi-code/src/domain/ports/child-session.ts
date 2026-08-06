import type { ResolvedAgent } from "../agents/agent.ts";

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
  /** Resolved agent definition; the default agent or a discovered agent. */
  agent: ResolvedAgent;
  /** Instruction to run in the child session. */
  prompt: string;
  /** Parent session id, preserved in the child session header. */
  parentSessionId?: string;
  /** Stored transcript to reopen for a resume, if any. */
  sessionFile?: string;
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
