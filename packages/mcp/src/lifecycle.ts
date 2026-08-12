import type { AgentToolResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { McpToolExposer, type McpToolSnapshotEntry } from "./expose.ts";
import { normalizeCallToolResult, type NormalizedDetails } from "./results.ts";
import { McpPromptsResourcesExposer, type McpAuthorize } from "./prompts-exposer.ts";
import { normalizePromptResult, normalizeResourceResult } from "./prompts-resources.ts";
import { evaluatePolicy, policyFromConfig, type PolicyTarget } from "./policy.ts";
import { redactDiagnostic } from "./diagnostics.ts";
import { userAgentDir } from "./config.ts";
import { publishSessionMcpBridge, publishSessionMcpDefinitions, publishSessionMcpNames, clearMcpNames, clearSessionMcpBridge, sessionMcpBridge } from "@xzy-ai/core";
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
  const authorizers = new Map<string, McpAuthorize>();
  const reconciles = new Map<string, () => void>();
  const disposed = new Set<string>();
  const knownMcpToolNames = new Set<string>();
  const sharedExposer = new McpToolExposer(pi, { manageActiveTools: false });
  const sharedPromptResourceExposer = new McpPromptsResourcesExposer(pi, {
    authorize: async (kind, serverName, itemName, ctx) => {
      if (!ctx) return false;
      const key = managerKey(ctx);
      const authorize = authorizers.get(key);
      if (authorize) return authorize(kind, serverName, itemName, ctx);
      // Isolated child sessions never emit session_start, so no authorizer is
      // registered for them. They inherit MCP through a parent-published bridge;
      // the parent already authorized the servers it exposes and a child can only
      // reach resources the parent explicitly bridged. Authorize resource access
      // by bridge presence; the read/list path still rejects unknown servers.
      if (kind === "resource") return sessionMcpBridge(ctx.cwd, ctx.sessionManager.getSessionId()) !== undefined;
      return false;
    },
  });
  let sharedRevision = 1;

  const managerKey = (ctx: ExtensionContext): string => `${ctx.cwd}\u0000${ctx.sessionManager.getSessionId()}`;
  const notify = (ctx: ExtensionContext, message: string): void => {
    if (ctx.hasUI) ctx.ui.notify(message, "info");
    else pi.sendUserMessage(message, { deliverAs: "steer" });
  };
  const reconcileActiveTools = (): void => {
    try {
      const active = new Set(pi.getActiveTools());
      for (const name of knownMcpToolNames) active.delete(name);
      for (const mapping of sharedExposer.mappingsSnapshot()) {
        knownMcpToolNames.add(mapping.piName);
        active.add(mapping.piName);
      }
      pi.setActiveTools([...active]);
    } catch {
      // Hosts without dynamic active-tool control remain registration-only.
    }
  };

  sharedExposer.setInvokeHandler(async (mapping, args, signal, invokeCtx): Promise<AgentToolResult<NormalizedDetails>> => {
    const key = managerKey(invokeCtx);
    const manager = managers.get(key);
    const authorize = authorizers.get(key);
    if (!manager || !authorize) {
      return normalizeCallToolResult(undefined, { server: mapping.serverName, tool: mapping.nativeName, transportError: "MCP session is no longer available" });
    }
    if (!(await authorize("tool", mapping.serverName, mapping.nativeName, invokeCtx))) {
      return normalizeCallToolResult(undefined, { server: mapping.serverName, tool: mapping.nativeName, policyDenied: true });
    }
    try {
      const raw = await manager.callTool(mapping.serverName, mapping.nativeName, args, signal);
      return normalizeCallToolResult(raw, { server: mapping.serverName, tool: mapping.nativeName });
    } catch (error) {
      return normalizeCallToolResult(undefined, { server: mapping.serverName, tool: mapping.nativeName, cancelled: signal?.aborted, transportError: error instanceof Error ? error.message : String(error) });
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    const key = managerKey(ctx);
    const existing = managers.get(key);
    if (existing) return;
    disposed.delete(key);
    let reconcile: (() => void) | undefined;
    const manager = createMcpManager({
      ...options,
      projectRoot: ctx.cwd,
      ownerKey: managerKey(ctx),
      agentDir: userAgentDir(options.agentDir),
      onConfigChanged: (names) => {
        if (disposed.has(key) || managers.get(key) !== manager) return;
        reconcile?.();
      },
      onServerChanged: (name) => {
        if (disposed.has(key) || managers.get(key) !== manager) return;
        reconcile?.();
      },
      onCatalogChanged: (serverName) => {
        if (disposed.has(key) || managers.get(key) !== manager) return;
        void manager.refreshCatalog(serverName).then(
          () => {
            if (!disposed.has(key) && managers.get(key) === manager) reconcile?.();
          },
          () => {
            if (!disposed.has(key) && managers.get(key) === manager) reconcile?.();
          },
        );
      },
    });
    managers.set(key, manager);
    const authorize: McpAuthorize = async (kind, serverName, itemName, authorizationCtx) => {
      try {
        if (options.authorize) return Boolean(await options.authorize(kind, serverName, itemName, authorizationCtx));
        const policy = policyFromConfig(manager.state().config?.permissions);
        const decision = evaluatePolicy(policy, kind as PolicyTarget, serverName, itemName);
        if (decision.effect === "allow") return true;
        if (decision.effect === "deny") return false;
        if (!authorizationCtx?.hasUI || typeof authorizationCtx.ui?.confirm !== "function") return false;
        return Boolean(await authorizationCtx.ui.confirm("MCP permission", `Allow ${kind} ${serverName}/${itemName}?`));
      } catch {
        // Permission prompts are a security boundary: unavailable or broken UI
        // and broken custom authorizers fail closed without escaping the call.
        return false;
      }
    };
    authorizers.set(key, authorize);

    authorizers.set(key, authorize);
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
    sharedPromptResourceExposer.registerSession(key, { manager, readPrompt, readResource, listResources: (serverName) => {
      if (!manager.state().servers[serverName]) return undefined;
      return (manager.resourcesFor(serverName) ?? []).map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      }));
    } });
    let revision = 1;
    reconcile = () => {
      const snapshot: McpToolSnapshotEntry[] = [];
      for (const serverName of manager.serverNames()) {
        for (const tool of manager.toolsFor(serverName) ?? []) {
          snapshot.push({ serverName, nativeName: tool.name, description: tool.description, inputSchema: tool.inputSchema });
        }
      }
      sharedExposer.syncSession(key, snapshot, sharedRevision++);
      const definitions = snapshot.map((entry) => {
        const mapping = sharedExposer.mappingForIdentity(entry.serverName, entry.nativeName);
        return mapping ? { name: mapping.piName, description: mapping.description, parameters: mapping.parameters as unknown } : undefined;
      }).filter((definition): definition is { name: string; description: string; parameters: unknown } => definition !== undefined);
      const childNames = definitions.map((definition) => definition.name);
      publishSessionMcpNames(ctx, childNames);
      publishSessionMcpDefinitions(ctx, definitions);
      sharedPromptResourceExposer.syncSession(key);
      reconcileActiveTools();
    };
    publishSessionMcpBridge(ctx, {
      invokeTool: async (name, args, signal) => {
        const mapping = sharedExposer.mapping(name);
        if (!mapping) return normalizeCallToolResult(undefined, { server: "unknown", tool: name, transportError: "MCP tool is no longer available" });
        return sharedExposer.invokeForSession(mapping, args, signal, ctx);
      },
      listResources: (server) => manager.resourcesFor(server),
      readResource: async (server, uri, signal) => readResource(server, uri, signal),
    });
    reconcile();
    reconciles.set(key, reconcile);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const key = managerKey(ctx);
    const manager = managers.get(key);
    if (!manager) return;
    disposed.add(key);
    managers.delete(key);
    authorizers.delete(key);
    sharedExposer.removeSession(key, sharedRevision++);
    sharedPromptResourceExposer.removeSession(key);
    clearMcpNames(ctx);
    clearSessionMcpBridge(ctx);
    reconciles.delete(key);
    await manager.stop();
    reconcileActiveTools();
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
              ownerKey: managerKey(ctx),
              oauth: server.oauth,
              onRedirect: async (url) => {
                notify(ctx, `MCP auth \"${name}\": open ${redactDiagnostic(url.toString())}`);
              },
            });
            // When the user completes the browser flow, the loopback callback
            // resolves the authorization code and finishRemoteAuth commits it.
            void started.callback.then(
              async (code) => {
                if (!code) return;
                await finishRemoteAuth({ url: server.url, agentDir, ownerKey: managerKey(ctx), oauth: server.oauth, onRedirect: async () => {} }, code);
                notify(ctx, `MCP auth \"${name}\": authorized.`);
              },
              async () => {
                notify(ctx, `MCP auth \"${name}\": cancelled or expired.`);
              },
            ).catch((error: unknown) => {
              notify(ctx, `MCP auth \"${name}\": ${redactDiagnostic(error)}`);
            });
          } catch (error) {
            notify(ctx, `MCP auth \"${name}\": ${redactDiagnostic(error)}`);
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
          logoutRemote({ url: server.url, agentDir, ownerKey: managerKey(ctx), oauth: server.oauth, onRedirect: () => {} });
          notify(ctx, `MCP: logged out \"${name}\".`);
          return;
        }
        case "status":
        case "list": {
          const rows = Object.entries(manager.state().servers).map(([serverName, status]) => {
            const tools = manager.toolsFor(serverName)?.length ?? 0;
            const prompts = manager.promptsFor(serverName)?.length ?? 0;
            const resources = manager.resourcesFor(serverName)?.length ?? 0;
            const mappings = sharedExposer.mappingsSnapshot()
              .filter((mapping) => mapping.serverName === serverName)
              .map((mapping) => `${mapping.piName}->${mapping.nativeName}`)
              .join(",") || "-";
            return `${serverName}: ${status.status} errorCategory=${status.errorCategory} tools=${tools} prompts=${prompts} resources=${resources} mappings=${mappings}`;
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
          if (!manager.state().servers[name]) {
            notify(ctx, `MCP: unknown server "${name}".`);
            return;
          }
          await manager.disconnect(name);
          reconciles.get(managerKey(ctx))?.();
          notify(ctx, `MCP: disconnected ${name}.`);
          return;
        }
        case "reload": {
          manager.reload();
          await manager.reconcile();
          reconciles.get(managerKey(ctx))?.();
          notify(ctx, "MCP: configuration reloaded.");
          return;
        }
        case "debug": {
          const rows = Object.entries(manager.state().servers).map(([serverName, status]) => {
            const category = status.errorCategory === "none" ? "" : ` errorCategory=${status.errorCategory}`;
            const detail = status.status === "failed" || status.status === "needs_client_registration" ? ` error=${redactDiagnostic(status.error)}` : "";
            return `${serverName}: ${status.status}${category}${detail}`;
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