import { DEFAULT_MAX_AGENT_DEPTH } from "@xzy-ai/core";
import { resolveSettingsForProject } from "./settings.ts";

/**
 * Resolve the maximum recursive agent depth through the centralized settings
 * resolver. The existing environment alias remains the highest-precedence
 * override. File settings are hard-migrated to `agents.maxAgentDepth`; the
 * legacy root `maxAgentDepth` key is intentionally ignored.
 */
export function maxAgentDepth(cwd?: string): number {
  const settings = resolveSettingsForProject(cwd);
  // Keep this fallback local to make the public compatibility seam total even
  // if a future resolver implementation ever returns an incomplete object.
  return settings.agents.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH;
}
