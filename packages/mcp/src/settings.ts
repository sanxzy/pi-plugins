import { resolveSettingsForProject, type McpSettings } from "@xzy-ai/runtime";

/**
 * Resolve the centralized MCP settings group for a project. These values act
 * as manager-level defaults; `mcp.json` per-server and global timeout values
 * continue to take precedence over the startup/request defaults.
 */
export function resolveMcpSettings(projectRoot: string): McpSettings {
  return resolveSettingsForProject(projectRoot).mcp;
}