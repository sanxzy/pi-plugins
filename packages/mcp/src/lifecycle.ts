import type { AgentToolResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { McpToolExposer, type McpToolSnapshotEntry } from "./expose.ts";
import { normalizeCallToolResult, type NormalizedDetails } from "./results.ts";
import { McpPromptsResourcesExposer, type McpAuthorize } from "./prompts-exposer.ts";
import { normalizePromptResult, normalizeResourceResult } from "./prompts-resources.ts";
import { evaluatePolicy, policyFromConfig, type PolicyTarget } from "./policy.ts";
import { userAgentDir } from "./config.ts";
import { createMcpManager, type McpManager, type McpManagerOptions } from "./manager.ts";
import {
  startRemoteAuth,
  finishRemoteAuth,
  logoutRemote,
} from "./remote.ts";

export interface McpLifecycleRegistrationOptions extends Omit<McpManagerOptions, "projectRoot"> {
  agentDir?: string;
  /** Authorization hook shared by prompt and resource calls (default allow). */
  authorize?: McpAuthorize;
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
  const reconciles = new Map<string, () => void>();

  const managerKey = (ctx: ExtensionContext): string => `${ctx.cwd}\u0000${ctx.sessionManager.getSessionId()}`;
  const notify = (ctx: ExtensionContext, message: string): void => {
    if (ctx.hasUI) ctx.ui.notify(message, "info");
    else pi.sendUserMessage(message, { deliverAs: "steer" });
  };

  pi.on("session_start", async (_event, ctx) => {
    const key = managerKey(ctx);
    const existing = managers.get(key);
    if (existing) return;
    let reconcile: (() => void) | undefined;
    const manager = createMcpManager({
      ...options,
      projectRoot: ctx.cwd,
      agentDir: userAgentDir(options.agentDir),
      onCatalogChanged: (serverName) => {
        void manager.refreshCatalog(serverName).then(
          () => reconcile?.(),
          () => reconcile?.(),
        );
      },
    });
    managers.set(key, manager);
    const authorize: McpAuthorize = async (kind, serverName, itemName, authorizationCtx) => {
      if (options.authorize) return options.authorize(kind, serverName, itemName, authorizationCtx);
      const policy = policyFromConfig(manager.state().config?.permissions);
      const decision = evaluatePolicy(policy, kind as PolicyTarget, serverName, itemName);
      if (decision.effect === "allow") return true;
      if (decision.effect === "deny") return false;
      if (!authorizationCtx?.hasUI) return false;
      return authorizationCtx.ui.confirm("MCP permission", `Allow ${kind} ${serverName}/${itemName}?`);
    };
    const exposer = new McpToolExposer(pi);
    exposer.setInvokeHandler(async (mapping, args, signal, invokeCtx): Promise<AgentToolResult<NormalizedDetails>> => {
      if (!(await authorize("tool", mapping.serverName, mapping.nativeName, invokeCtx))) {
        return normalizeCallToolResult(undefined, {
          server: mapping.serverName,
          tool: mapping.nativeName,
          policyDenied: true,
        });
      }
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

    const promptResourceExposer = new McpPromptsResourcesExposer(pi, { authorize });
    const readPrompt = async (serverName: string, nativeName: string, args: Record<string, string>, signal?: AbortSignal) => {
      try {
        return normalizePromptResult(serverName, nativeName, await manager.getPrompt(serverName, nativeName, args, signal));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return normalizePromptResult(serverName, nativeName, undefined, {
          cancelled: signal?.aborted,
          unavailable: /not connected/i.test(message),
          transportError: /not connected/i.test(message) ? undefined : message,
        });
      }
    };
    const readResource = async (serverName: string, uri: string, signal?: AbortSignal) => {
      try {
        return normalizeResourceResult(serverName, uri, await manager.readResource(serverName, uri, signal));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return normalizeResourceResult(serverName, uri, undefined, {
          cancelled: signal?.aborted,
          unavailable: /not connected/i.test(message),
          transportError: /not connected/i.test(message) ? undefined : message,
        });
      }
    };
    await manager.start();
    promptResourceExposer.register(manager, readPrompt, readResource, (serverName) =>
      (manager.resourcesFor(serverName) ?? []).map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      })),
    );
    let revision = 1;
    reconcile = () => {
      const snapshot: McpToolSnapshotEntry[] = [];
      for (const serverName of manager.serverNames()) {
        for (const tool of manager.toolsFor(serverName) ?? []) {
          snapshot.push({ serverName, nativeName: tool.name, description: tool.description, inputSchema: tool.inputSchema });
        }
      }
      exposer.sync(snapshot, revision++);
      promptResourceExposer.syncPrompts(manager, readPrompt);
    };
    reconcile();
    reconciles.set(key, reconcile);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const key = managerKey(ctx);
    const manager = managers.get(key);
    if (!manager) return;
    managers.delete(key);
    exposers.delete(key);
    reconciles.delete(key);
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
        case "status":
        case "list": {
          const rows = Object.entries(manager.state().servers).map(([serverName, status]) => {
            const tools = manager.toolsFor(serverName)?.length ?? 0;
            const prompts = manager.promptsFor(serverName)?.length ?? 0;
            const resources = manager.resourcesFor(serverName)?.length ?? 0;
            return `${serverName}: ${status.status} tools=${tools} prompts=${prompts} resources=${resources}`;
          });
          notify(ctx, rows.length ? `MCP ${sub}:\n${rows.join("\n")}` : "MCP: no servers configured.");
          return;
        }
        case "connect": {
          if (!name || !server) {
            notify(ctx, "MCP connect usage: /mcp connect <server>");
            return;
          }
          const result = server.type === "local"
            ? await manager.connectLocal(name, server)
            : await manager.connectRemote(name, server);
          reconciles.get(managerKey(ctx))?.();
          notify(ctx, `MCP: ${name} ${result.status.status}.`);
          return;
        }
        case "disconnect": {
          if (!name) {
            notify(ctx, "MCP disconnect usage: /mcp disconnect <server>");
            return;
          }
          await manager.disconnect(name);
          reconciles.get(managerKey(ctx))?.();
          notify(ctx, `MCP: disconnected ${name}.`);
          return;
        }
        case "reload": {
          manager.reload();
          reconciles.get(managerKey(ctx))?.();
          notify(ctx, "MCP: configuration reloaded.");
          return;
        }
        case "debug": {
          const rows = Object.entries(manager.state().servers).map(([serverName, status]) => {
            const safeError = status.status === "failed" || status.status === "needs_client_registration" ? ` error=${safeDiagnostic(status.error)}` : "";
            return `${serverName}: ${status.status}${safeError}`;
          });
          notify(ctx, `MCP debug:\n${rows.join("\n") || "no servers"}`);
          return;
        }
        default:
          notify(ctx, `MCP: unknown subcommand \"${sub}\".`);
      }
    },
  });
}

function safeDiagnostic(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,]+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:token|access_token|refresh_token|client_secret|code_verifier)=)[^&\s]+/gi, "$1[REDACTED]")
    .slice(0, 1_000);
}