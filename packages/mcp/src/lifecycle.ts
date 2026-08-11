import type { AgentToolResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { McpToolExposer, type McpToolSnapshotEntry } from "./expose.ts";
import { normalizeCallToolResult, type NormalizedDetails } from "./results.ts";
import { McpPromptsResourcesExposer } from "./prompts-exposer.ts";
import { normalizePromptResult, normalizeResourceResult } from "./prompts-resources.ts";
import { userAgentDir } from "./config.ts";
import { createMcpManager, type McpManager, type McpManagerOptions } from "./manager.ts";
import {
  startRemoteAuth,
  finishRemoteAuth,
  logoutRemote,
} from "./remote.ts";

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
  const exposers = new Map<string, McpToolExposer>();

  const managerKey = (ctx: ExtensionContext): string => `${ctx.cwd}\u0000${ctx.sessionManager.getSessionId()}`;
  const notify = (ctx: ExtensionContext, message: string): void => {
    if (ctx.hasUI) ctx.ui.notify(message, "info");
    else pi.sendUserMessage(message, { deliverAs: "steer" });
  };

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
    const exposer = new McpToolExposer(pi);
    exposer.setInvokeHandler(async (mapping, args, signal, invokeCtx): Promise<AgentToolResult<NormalizedDetails>> => {
      try {
        const raw = await manager.callTool(mapping.serverName, mapping.nativeName, args, signal);
        return normalizeCallToolResult(raw, { server: mapping.serverName, tool: mapping.nativeName });
      } catch (error) {
        return normalizeCallToolResult(undefined, {
          server: mapping.serverName,
          tool: mapping.nativeName,
          cancelled: signal?.aborted,
          transportError: error instanceof Error ? error.message : String(error),
        });
      }
    });
    exposers.set(key, exposer);
    await manager.start();
    const snapshot: McpToolSnapshotEntry[] = [];
    for (const serverName of manager.serverNames()) {
      for (const tool of manager.toolsFor(serverName) ?? []) {
        snapshot.push({
          serverName,
          nativeName: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    }
    exposer.sync(snapshot, 1);

    const promptResourceExposer = new McpPromptsResourcesExposer(pi);
    promptResourceExposer.register(
      manager,
      async (serverName, nativeName, args, signal) => {
        try {
          return normalizePromptResult(serverName, nativeName, await manager.getPrompt(serverName, nativeName, args, signal));
        } catch (error) {
          return normalizePromptResult(serverName, nativeName, undefined, {
            cancelled: signal?.aborted,
            transportError: error instanceof Error ? error.message : String(error),
          });
        }
      },
      async (serverName, uri, signal) => {
        try {
          return normalizeResourceResult(serverName, uri, await manager.readResource(serverName, uri, signal));
        } catch (error) {
          return normalizeResourceResult(serverName, uri, undefined, {
            cancelled: signal?.aborted,
            transportError: error instanceof Error ? error.message : String(error),
          });
        }
      },
      (serverName) => (manager.resourcesFor(serverName) ?? []).map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      })),
    );
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const key = managerKey(ctx);
    const manager = managers.get(key);
    if (!manager) return;
    managers.delete(key);
    exposers.delete(key);
    await manager.stop();
  });

  // Control-plane commands operate on the manager for the invoking session.
  pi.registerCommand("mcp", {
    description: "Manage MCP servers: auth, logout, status, reload, connect, disconnect.",
    async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "status";
      const name = parts[1];
      const manager = managers.get(managerKey(ctx));
      if (!manager) {
        notify(ctx, "MCP: no manager is active for this session.");
        return;
      }
      const server = name ? manager.state().config?.servers[name] : undefined;
      switch (sub) {
        case "auth": {
          if (!server || server.type !== "remote" || server.oauth === false) {
            notify(ctx, name ? `MCP: \"${name}\" is not a remote OAuth server.` : "MCP auth usage: /mcp auth <server>");
            return;
          }
          const agentDir = userAgentDir(options.agentDir);
          try {
            const started = await startRemoteAuth({
              url: server.url,
              agentDir,
              oauth: server.oauth,
              onRedirect: async (url) => {
                notify(ctx, `MCP auth \"${name}\": open ${url.toString()}`);
              },
            });
            // When the user completes the browser flow, the loopback callback
            // resolves the authorization code and finishRemoteAuth commits it.
            void started.callback.then(
              async (code) => {
                if (!code) return;
                await finishRemoteAuth({ url: server.url, agentDir, oauth: server.oauth, onRedirect: async () => {} }, code);
                notify(ctx, `MCP auth \"${name}\": authorized.`);
              },
              async () => {
                notify(ctx, `MCP auth \"${name}\": cancelled or expired.`);
              },
            ).catch((error: unknown) => {
              notify(ctx, `MCP auth \"${name}\": ${error instanceof Error ? error.message : String(error)}`);
            });
          } catch (error) {
            notify(ctx, `MCP auth \"${name}\": ${error instanceof Error ? error.message : String(error)}`);
          }
          return;
        }
        case "logout": {
          if (!server || server.type !== "remote") {
            notify(ctx, name ? `MCP: \"${name}\" is not a remote server.` : "MCP logout usage: /mcp logout <server>");
            return;
          }
          const agentDir = userAgentDir(options.agentDir);
          // Close any active transport first so logout leaves no authenticated
          // client alive, then clear credentials and pending callbacks.
          await manager.disconnect(name);
          logoutRemote({ url: server.url, agentDir, oauth: server.oauth, onRedirect: () => {} });
          notify(ctx, `MCP: logged out \"${name}\".`);
          return;
        }
        case "status": {
          const rows = Object.entries(manager.state().servers).map(([s, status]) => `${s}: ${status.status}`);
          notify(ctx, rows.length ? `MCP status:\n${rows.join("\n")}` : "MCP: no servers configured.");
          return;
        }
        default:
          notify(ctx, `MCP: unknown subcommand \"${sub}\".`);
      }
    },
  });
}