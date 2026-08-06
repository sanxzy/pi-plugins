/**
 * Agent-definition types.
 *
 * Phase 3 recognizes only the inherited default agent; Phase 8 replaces this
 * with full agent discovery. The agent name is opaque here — it is resolved by
 * an infrastructure seam, never by the registry or the domain model.
 */

/**
 * A resolved agent definition that can run a child session.
 *
 * Phase 3 only supports the inherited default agent, whose system prompt and
 * tools come from the parent runtime. Later phases add discovered agents with
 * explicit system-prompt bodies and tool allowlists.
 */
export interface AgentDefinition {
  /** Stable name used by the `task` tool's `subagent_type` parameter. */
  readonly name: string;
  /** Whether this agent is the default inherited agent. */
  readonly isDefault: boolean;
}