import type { AgentDefinition } from "./agent.ts";

/**
 * The default (inherited) agent.
 *
 * A child created for this agent inherits the parent session's model and
 * runtime defaults. This is the only agent recognized in Phase 3.
 */
export const DEFAULT_AGENT: AgentDefinition = {
  name: "default",
  isDefault: true,
};

/** Whether a subagent type resolves to the default inherited agent. */
export function isDefaultAgentName(name: string): boolean {
  return name === DEFAULT_AGENT.name;
}