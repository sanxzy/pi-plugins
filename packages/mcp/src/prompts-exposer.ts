import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { compactMcpLabel, renderMcpCall, renderMcpResult } from "./render.ts";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import { sessionMcpBridge } from "@xzy-ai/core";
import { MCP_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { NameRegistry } from "./naming.ts";
import { promptResultToText, resourceResultToText, type McpPromptResult, type McpResourceResult } from "./prompts-resources.ts";

/** Authorization hook shared with policy (Phase 6 wires the real rules). */
export type McpAuthorize = (
  kind: "tool" | "prompt" | "resource",
  serverName: string,
  name: string,
  ctx?: ExtensionContext,
) => Promise<boolean> | boolean;

export interface McpReadPrompt {
  (serverName: string, nativeName: string, args: Record<string, string>, signal: AbortSignal | undefined, ctx?: ExtensionContext): Promise<McpPromptResult>;
}

export interface McpResourceAccess {
  (serverName: string, uri: string, signal: AbortSignal | undefined, ctx?: ExtensionContext): Promise<McpResourceResult>;
}

export interface McpResourceLister {
  (serverName: string, ctx?: ExtensionContext): Array<{ uri: string; name: string; description?: string; mimeType?: string }> | undefined;
}

export interface McpPromptsResourcesOptions {
  authorize?: McpAuthorize;
}

export interface McpManagerLike {
  serverNames(): string[];
  promptsFor(name: string): Prompt[] | undefined;
}

export interface McpSessionBinding {
  manager: McpManagerLike;
  readPrompt: McpReadPrompt;
  readResource: McpResourceAccess;
  listResources: McpResourceLister;
}

const PROMPT_COMMAND_PREFIX = "mcp_prompt_";

/**
 * Exposes MCP prompts as Pi slash commands and resources as model-facing
 * list/read tools. Removed commands remain registered but dispatch through a
 * live mapping and become unavailable without calling stale MCP clients.
 *
 * In a multi-session host the same model-facing names are shared; invocation
 * routes through the session that invoked the command/tool via the Pi context,
 * so one session's manager never executes another session's catalog.
 */
export class McpPromptsResourcesExposer {
  private readonly promptCommands = new Map<string, string>(); // commandName -> identity
  private readonly identityNames = new Map<string, string>();
  private readonly promptRegistry = new NameRegistry();
  private readonly sessions = new Map<string, McpSessionBinding>();
  private readonly activeSessions = new Map<string, boolean>();
  private legacyBinding?: McpSessionBinding;
  private resourcesRegistered = false;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly options: McpPromptsResourcesOptions = {},
  ) {
    // Resource list/read tools are stateless: they route through the invoking
    // session's binding via the Pi context. Register them eagerly so isolated
    // child sessions, which never emit a session_start extension event, still
    // expose the model-facing resource tools that their allowlist grants.
    this.ensureResourcesRegistered();
  }

  private ensureResourcesRegistered(): void {
    if (this.resourcesRegistered) return;
    this.registerResourceTools(
      (server, uri, signal, ctx) => this.sessionFor(ctx)?.readResource(server, uri, signal, ctx) ?? Promise.resolve({ server, uri, text: "", isError: true, failure: "unavailable" }),
      (server, ctx) => this.sessionFor(ctx)?.listResources(server, ctx),
    );
    this.resourcesRegistered = true;
  }

  /** Set whether one session currently has an active MCP server. */
  setActive(sessionKey: string, active: boolean): void {
    if (active) this.activeSessions.set(sessionKey, true);
    else this.activeSessions.delete(sessionKey);
  }

  /** Whether any session currently exposes an active MCP surface. */
  hasActive(): boolean {
    return this.activeSessions.size > 0;
  }

  register(
    manager: McpManagerLike,
    readPrompt: McpReadPrompt,
    readResource: McpResourceAccess,
    listResources: McpResourceLister,
  ): void {
    this.legacyBinding = { manager, readPrompt, readResource, listResources };
    this.syncAllPrompts();
    this.ensureResourcesRegistered();
  }

  registerSession(sessionKey: string, binding: McpSessionBinding): void {
    this.sessions.set(sessionKey, binding);
    this.syncAllPrompts();
    this.ensureResourcesRegistered();
  }

  removeSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
    this.activeSessions.delete(sessionKey);
    this.syncAllPrompts();
  }

  syncSession(sessionKey: string): void {
    if (this.sessions.has(sessionKey)) this.syncAllPrompts();
  }

  private sessionFor(ctx?: ExtensionContext): McpSessionBinding | undefined {
    if (!ctx) return this.legacyBinding;
    const sm = (ctx as unknown as { sessionManager?: { getSessionId?: () => string } }).sessionManager;
    const sessionId = sm?.getSessionId ? sm.getSessionId() : undefined;
    if (sessionId === undefined) return this.legacyBinding;
    const bound = this.sessions.get(`${ctx.cwd}\u0000${sessionId}`) ?? this.legacyBinding;
    if (bound) return bound;
    const bridge = sessionMcpBridge(ctx.cwd, sessionId);
    if (!bridge) return undefined;
    // Isolated child sessions inherit a bridge but do not own a local MCP
    // manager. Present the same resource surface through that bridge.
    return {
      manager: { serverNames: () => [], promptsFor: () => [] },
      readPrompt: async (server, prompt) => ({ server, prompt, messages: [], isError: true, failure: "unavailable" }),
      readResource: (server, uri, signal) => Promise.resolve(bridge.readResource(server, uri, signal)) as Promise<McpResourceResult>,
      listResources: (server) => bridge.listResources(server) as Array<{ uri: string; name: string; description?: string; mimeType?: string }> | undefined,
    };
  }

  private syncAllPrompts(): void {
    const next = new Map<string, string>();
    const managers = [
      ...(this.legacyBinding ? [this.legacyBinding.manager] : []),
      ...[...this.sessions.values()].map((session) => session.manager),
    ];
    for (const manager of managers) {
      for (const serverName of manager.serverNames()) {
        for (const prompt of manager.promptsFor(serverName) ?? []) {
          const identity = identityKey(serverName, prompt.name);
          const commandName = this.identityNames.get(identity)
            ?? `${PROMPT_COMMAND_PREFIX}${this.promptRegistry.resolve(serverName, prompt.name)}`;
          next.set(identity, commandName);
          if (!this.identityNames.has(identity)) {
            this.identityNames.set(identity, commandName);
            this.pi.registerCommand(commandName, {
              description: buildPromptDescription(prompt, serverName),
              handler: async (args: string, ctx: ExtensionContext): Promise<void> => {
                await this.handlePrompt(commandName, args, ctx);
              },
            });
          }
          this.promptCommands.set(commandName, identity);
        }
      }
    }
    for (const [identity, commandName] of this.identityNames) {
      if (!next.has(identity)) this.promptCommands.delete(commandName);
    }
  }

  syncPrompts(manager: McpManagerLike, readPrompt: McpReadPrompt): void {
    if (this.legacyBinding) {
      this.legacyBinding = { manager, readPrompt, readResource: this.legacyBinding.readResource, listResources: this.legacyBinding.listResources };
    }
    this.syncAllPrompts();
  }

  private async handlePrompt(commandName: string, args: string, ctx: ExtensionContext): Promise<void> {
    return processWithLog({ operation: MCP_OPERATIONS.HANDLE_PROMPT, parameters: { commandName, args } }, async () => {
      const identity = this.promptCommands.get(commandName);
      if (!identity) {
        this.output(ctx, "Error: MCP prompt is no longer available.");
        return;
      }
      const [serverName, nativeName] = splitIdentity(identity);
      const allowed = this.options.authorize ? await this.options.authorize("prompt", serverName, nativeName, ctx) : true;
      if (!allowed) {
        this.output(ctx, "Error: MCP prompt denied by policy.");
        return;
      }
      const reader = this.sessionFor(ctx)?.readPrompt;
      if (!reader) {
        this.output(ctx, "Error: MCP prompt session is unavailable.");
        return;
      }
      const result = await reader(serverName, nativeName, parsePromptArgs(args), ctx.signal, ctx);
      this.output(ctx, promptResultToText(result));
    });
  }

  private registerResourceTools(readResource: McpResourceAccess, listResources: McpResourceLister): void {
    this.pi.registerTool({
      name: "mcp_resources_list",
      label: "MCP resources list",
      description: "List MCP resources from a configured server. Use mcp_resources_read to read a URI.",
      parameters: { type: "object", properties: { server: { type: "string" } }, required: ["server"] } as never,
      execute: async (_id, params: { server: string }, _signal, _onUpdate, ctx) => processWithLog({
        operation: MCP_OPERATIONS.RESOURCE_LIST,
        parameters: { server: params?.server },
      }, async () => {
        const server = String(params?.server ?? "");
        if (this.options.authorize && !(await this.options.authorize("resource", server, "", ctx))) {
          return { content: [{ type: "text", text: "Error: MCP resource listing denied by policy" }], details: { server, denied: true } };
        }
        const available = listResources(server, ctx);
        if (available === undefined) {
          return { content: [{ type: "text", text: `Error: unknown MCP server "${server}"` }], details: { server, denied: false, unknown: true } };
        }
        const resources = available;
        const text = resources.length
          ? resources.map((r) => `${r.uri}\t${r.name}${r.description ? `\t${r.description.slice(0, 1_000)}` : ""}`).join("\n")
          : "(no resources)";
        return { content: [{ type: "text", text }], details: { server, count: resources.length } };
      }),
      renderCall: (args, theme, context) => renderMcpCall("resources_list", compactMcpLabel((args as { server?: unknown }).server), theme, { ...context, args }),
      renderResult: (result, options, theme, context) => renderMcpResult("resources_list", result, options, theme, context),
    });
    this.pi.registerTool({
      name: "mcp_resources_read",
      label: "MCP resources read",
      description: "Read an MCP resource by server and URI.",
      parameters: {
        type: "object",
        properties: { server: { type: "string" }, uri: { type: "string" } },
        required: ["server", "uri"],
      } as never,
      execute: async (_id, params: { server: string; uri: string }, signal, _onUpdate, ctx) => processWithLog({
        operation: MCP_OPERATIONS.RESOURCE_READ,
        parameters: { server: params?.server, uri: params?.uri },
      }, async () => {
        const server = String(params?.server ?? "");
        const uri = String(params?.uri ?? "");
        if (this.options.authorize && !(await this.options.authorize("resource", server, uri, ctx))) {
          return { content: [{ type: "text", text: "Error: MCP resource read denied by policy" }], details: { server, uri, denied: true } };
        }
        const result = await readResource(server, uri, signal, ctx);
        // The normalizer's `text` is the aggregate-bounded stream and includes
        // every omission message. Keep it as one model-facing text block, then
        // append only supported, size-bounded image attachments.
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
          { type: "text", text: resourceResultToText(result) },
        ];
        for (const block of result.content ?? []) {
          if (block.type === "image" && block.data && block.mimeType) {
            content.push({ type: "image", data: block.data, mimeType: block.mimeType });
          }
        }
        return { content, details: result };
      }),
      renderCall: (args, theme, context) => renderMcpCall("resources_read", `${compactMcpLabel((args as { server?: unknown }).server)}/${compactMcpLabel((args as { uri?: unknown }).uri)}`, theme, { ...context, args }),
      renderResult: (result, options, theme, context) => renderMcpResult("resources_read", result, options, theme, context),
    });
  }

  private output(ctx: ExtensionContext, text: string): void {
    // Prompt results enter the ordinary Pi session flow in every mode. Keep a
    // UI notification as a lightweight visual acknowledgement as well.
    this.pi.sendUserMessage(text, { deliverAs: "followUp" });
    if (ctx.hasUI) ctx.ui.notify("MCP prompt output sent to the session.", "info");
  }
}

function buildPromptDescription(prompt: Prompt, serverName: string): string {
  const args = (prompt.arguments ?? []).map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ");
  return [
    `Run MCP prompt "${prompt.name}" from server "${serverName}".`,
    ...(prompt.description ? [prompt.description.slice(0, 1_000)] : []),
    ...(args ? [`Arguments: ${args}`] : []),
  ].join(" ");
}

function identityKey(serverName: string, nativeName: string): string {
  return `${serverName}\u0000${nativeName}`;
}

function splitIdentity(identity: string): [string, string] {
  const idx = identity.indexOf("\u0000");
  return idx === -1 ? [identity, ""] : [identity.slice(0, idx), identity.slice(idx + 1)];
}

function parsePromptArgs(args: string): Record<string, string> {
  const trimmed = args.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
    }
  } catch {
    // key=value fallback below
  }
  const result: Record<string, string> = {};
  for (const pair of trimmed.split(/\s+/)) {
    const idx = pair.indexOf("=");
    if (idx > 0) result[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return result;
}