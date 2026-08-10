import type { DiscoveredAgent } from "../agents/agent.ts";

/**
 * Agent-discovery port.
 *
 * The application layer resolves a subagent type to an agent definition through
 * this seam. Infrastructure implements it over the PI SDK's agent directory and
 * project file discovery; no filesystem path or SDK type reaches the port.
 */
export interface AgentDiscovery {
  /**
   * Resolve a subagent type by name.
   *
   * A name resolves only when a valid agent file defines it. Invalid files are
   * skipped, so an unknown name resolves to `undefined` without erroring the
   * orchestrator.
   */
  resolve(name: string): DiscoveredAgent | undefined;
  /** Every discovered agent, project agents overriding same-name user agents. */
  all(): DiscoveredAgent[];
}
