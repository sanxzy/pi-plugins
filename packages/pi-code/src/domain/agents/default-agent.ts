import type { AgentDefinition } from "./agent.ts";

/**
 * The default (inherited) agent.
 *
 * A child created for this agent inherits the parent session's model and
 * runtime defaults, with no system-prompt override and no tool allowlist.
 */
export const DEFAULT_AGENT: AgentDefinition = {
  name: "default",
  isDefault: true,
};
