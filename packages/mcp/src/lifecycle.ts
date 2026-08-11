import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { userAgentDir } from "./config.ts";
import { createMcpManager, type McpManager, type McpManagerOptions } from "./manager.ts";

export interface McpLifecycleRegistrationOptions extends Omit<McpManagerOptions, "projectRoot"> {
  agentDir?: string;
}

/**
 * Register the MCP manager lifecycle against Pi session events.
 *
 * Each root session owns one session-scoped manager. The manager is keyed by
 * the canonical project root and the live session id so replacement, fork,
 * resume, and shutdown each get fresh, isolated state. Execution, transport,
 * tool exposure, and policy are added in later phases; this wiring only keeps
 * the configuration/status shell alive for the session.
 */
export function registerMcpLifecycle(pi: ExtensionAPI, options: McpLifecycleRegistrationOptions = {}): void {
  const managers = new Map<string, McpManager>();

  const managerKey = (ctx: ExtensionContext): string => `${ctx.cwd}\u0000${ctx.sessionManager.getSessionId()}`;

  pi.on("session_start", async (_event, ctx) => {
    const key = managerKey(ctx);
    const existing = managers.get(key);
    if (existing) return;
    const manager = createMcpManager({
      ...options,
      projectRoot: ctx.cwd,
      agentDir: userAgentDir(options.agentDir),
    });
    managers.set(key, manager);
    await manager.start();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const key = managerKey(ctx);
    const manager = managers.get(key);
    if (!manager) return;
    managers.delete(key);
    await manager.stop();
  });
}