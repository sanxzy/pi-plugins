/**
 * Child-session port.
 *
 * The application layer depends only on this function type. Infrastructure
 * implements it over the PI SDK; the composition root wires it into the
 * `task` tool. No session handle or PI SDK type reaches the port.
 */

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
 * `SessionManager`/`ModelRuntime`/`DefaultResourceLoader`. The subagent name
 * is resolved by the adapter seam; an unknown name returns `undefined` without
 * spawning a child.
 */
export type SpawnChildSession = (options: {
  /** Stable orchestrator job id, used as the child session id. */
  jobId: string;
  /** Working directory inherited from the parent session. */
  cwd: string;
  /** Subagent type to run; "default" is the only one recognized in Phase 3. */
  subagentType: string;
  /** Instruction to run in the child session. */
  prompt: string;
  /** Parent session id, preserved in the child session header. */
  parentSessionId?: string;
  /** Abort signal forwarded to the child's run. */
  signal?: AbortSignal;
  /**
   * Model inherited from the parent session.
   *
   * Opaque to the domain: the infrastructure adapter narrows it to the SDK
   * model type at the boundary. The tool guarantees this is defined before
   * calling the port.
   */
  model: unknown;
}) => Promise<ChildRunResult | undefined>;