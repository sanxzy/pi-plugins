import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
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
  (serverName: string, nativeName: string, args: Record<string, string>, signal: AbortSignal | undefined): Promise<McpPromptResult>;
}

export interface McpResourceAccess {
  (serverName: string, uri: string, signal: AbortSignal | undefined): Promise<McpResourceResult>;
}

export interface McpResourceLister {
  (serverName: string): Array<{ uri: string; name: string; description?: string; mimeType?: string }> | undefined;
}

export interface McpPromptsResourcesOptions {
  authorize?: McpAuthorize;
}

export interface McpManagerLike {
  serverNames(): string[];
  promptsFor(name: string): Prompt[] | undefined;
}

const PROMPT_COMMAND_PREFIX = "mcp_prompt_";

/**
 * Exposes MCP prompts as Pi slash commands and resources as model-facing
 * list/read tools. Removed commands remain registered but dispatch through a
 * live mapping and become unavailable without calling stale MCP clients.
 */
export class McpPromptsResourcesExposer {
  private readonly promptCommands = new Map<string, string>(); // commandName -> identity
  private readonly identityNames = new Map<string, string>();
  private readonly promptRegistry = new NameRegistry();
  private resourcesRegistered = false;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly options: McpPromptsResourcesOptions = {},
  ) {}

  register(
    manager: McpManagerLike,
    readPrompt: McpReadPrompt,
    readResource: McpResourceAccess,
    listResources: McpResourceLister,
  ): void {
    this.syncPrompts(manager, readPrompt);
    if (!this.resourcesRegistered) {
      this.registerResourceTools(readResource, listResources);
      this.resourcesRegistered = true;
    }
  }

  syncPrompts(manager: McpManagerLike, readPrompt: McpReadPrompt): void {
    const next = new Map<string, string>();
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
              await this.handlePrompt(commandName, args, readPrompt, ctx);
            },
          });
        }
        // Re-add a prompt's live dispatch mapping after a refresh.
        this.promptCommands.set(commandName, identity);
      }
    }
    for (const [identity, commandName] of this.identityNames) {
      if (!next.has(identity)) this.promptCommands.delete(commandName);
    }
  }

  private async handlePrompt(commandName: string, args: string, readPrompt: McpReadPrompt, ctx: ExtensionContext): Promise<void> {
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
    const result = await readPrompt(serverName, nativeName, parsePromptArgs(args), ctx.signal);
    this.output(ctx, promptResultToText(result));
  }

  private registerResourceTools(readResource: McpResourceAccess, listResources: McpResourceLister): void {
    this.pi.registerTool({
      name: "mcp_resources_list",
      label: "MCP resources list",
      description: "List MCP resources from a configured server. Use mcp_resources_read to read a URI.",
      parameters: { type: "object", properties: { server: { type: "string" } }, required: ["server"] } as never,
      execute: async (_id, params: { server: string }, _signal, _onUpdate, ctx) => {
        const server = String(params?.server ?? "");
        if (this.options.authorize && !(await this.options.authorize("resource", server, "", ctx))) {
          return { content: [{ type: "text", text: "Error: MCP resource listing denied by policy" }], details: { server, denied: true } };
        }
        const available = listResources(server);
        if (available === undefined) {
          return { content: [{ type: "text", text: `Error: unknown MCP server "${server}"` }], details: { server, denied: false, unknown: true } };
        }
        const resources = available;
        const text = resources.length
          ? resources.map((r) => `${r.uri}\t${r.name}${r.description ? `\t${r.description.slice(0, 1_000)}` : ""}`).join("\n")
          : "(no resources)";
        return { content: [{ type: "text", text }], details: { server, count: resources.length } };
      },
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
      execute: async (_id, params: { server: string; uri: string }, signal, _onUpdate, ctx) => {
        const server = String(params?.server ?? "");
        const uri = String(params?.uri ?? "");
        if (this.options.authorize && !(await this.options.authorize("resource", server, uri, ctx))) {
          return { content: [{ type: "text", text: "Error: MCP resource read denied by policy" }], details: { server, uri, denied: true } };
        }
        const result = await readResource(server, uri, signal);
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
      },
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
