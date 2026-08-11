import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { NameRegistry } from "./naming.ts";
import { objectSchemaFromMcp } from "./schema.ts";
import { normalizeCallToolResult, type NormalizedDetails } from "./results.ts";

/** Built-in Pi tool names reserved from MCP tool naming. */
export const DEFAULT_RESERVED_TOOL_NAMES = new Set([
  "read",
  "edit",
  "write",
  "bash",
  "grep",
  "find",
  "ls",
  "web_search",
  "web_fetch",
  "llm_wikis_search",
  "agent",
  "agent_status",
  "agent_list",
  "cancel",
  "status",
  "jobs",
  "question",
  "goal_create",
  "goal_status",
  "goal_pause",
  "goal_resume",
  "goal_clear",
  "telegram_chat",
]);

export interface McpToolSnapshotEntry {
  /** Configured server name in the effective MCP configuration. */
  serverName: string;
  /** Native MCP tool name as advertised by the server. */
  nativeName: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpToolMapping extends McpToolSnapshotEntry {
  piName: string;
  label: string;
  parameters: TSchema;
  revision: number;
}

export interface McpToolInvokeHandler {
  (
    mapping: McpToolMapping,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<NormalizedDetails>>;
}

/**
 * Materializes discovered MCP tools as individual Pi tools.
 *
 * The exposer owns the global Pi-name mapping (stable, collision-safe names
 * from the `NameRegistry`) and registers/updates each definition through
 * `pi.registerTool`. Execution is delegated to a handler supplied by the
 * lifecycle so the ACTIVE session's manager routes the call; this keeps
 * sessions isolated while sharing one stable registration surface (Pi tools
 * are registered once and cannot be unregistered, so removed MCP tools are
 * excluded by failing routing at invoke time).
 */
export class McpToolExposer {
  private readonly registry: NameRegistry;
  private readonly mappings = new Map<string, McpToolMapping>();
  private readonly byIdentity = new Map<string, string>();
  private invokeHandler: McpToolInvokeHandler | undefined;

  constructor(
    private readonly pi: ExtensionAPI,
    options: { reservedToolNames?: Iterable<string> } = {},
  ) {
    this.registry = new NameRegistry(new Set(options.reservedToolNames ?? DEFAULT_RESERVED_TOOL_NAMES));
  }

  setInvokeHandler(handler: McpToolInvokeHandler): void {
    this.invokeHandler = handler;
  }

  mapping(piName: string): McpToolMapping | undefined {
    return this.mappings.get(piName);
  }

  /** All currently registered mappings (newest revision for each piName). */
  mappingsSnapshot(): McpToolMapping[] {
    return [...this.mappings.values()];
  }

  /**
   * Sync a session snapshot of discovered tools. Registers new tools, updates
   * existing registrations with the newest binding, and returns which Pi names
   * were added or removed relative to the previous snapshot.
   */
  sync(
    snapshot: McpToolSnapshotEntry[],
    revision: number,
  ): { added: string[]; updated: string[]; removed: string[] } {
    const occupied = new Set<string>(this.mappings.keys());
    const next = new Map<string, McpToolMapping>();
    const byIdentity = new Map<string, string>();
    const added: string[] = [];
    const updated: string[] = [];

    for (const entry of snapshot) {
      const piName = this.registry.resolve(entry.serverName, entry.nativeName, occupied);
      occupied.add(piName);
      const mapping: McpToolMapping = {
        ...entry,
        piName,
        label: `MCP ${entry.serverName} ${entry.nativeName}`,
        description: toolDescription(entry),
        parameters: objectSchemaFromMcp(entry.inputSchema),
        revision,
      };
      next.set(piName, mapping);
      byIdentity.set(identityKey(entry.serverName, entry.nativeName), piName);
      if (!this.mappings.has(piName)) added.push(piName);
      else if (this.mappings.get(piName)?.revision !== revision) updated.push(piName);
    }

    const removed = [...this.mappings.keys()].filter((piName) => !next.has(piName));
    this.mappings.clear();
    this.byIdentity.clear();
    for (const [piName, mapping] of next) {
      this.mappings.set(piName, mapping);
      this.byIdentity.set(identityKey(mapping.serverName, mapping.nativeName), piName);
    }

    for (const [piName, mapping] of next) {
      this.register(piName, mapping);
    }
    return { added, updated, removed };
  }

  private register(piName: string, mapping: McpToolMapping): void {
    const pi = this.pi;
    const invoke = async (
      toolCallId: string,
      params: Record<string, never>,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<NormalizedDetails>> => {
      void toolCallId;
      const current = this.mappings.get(piName);
      if (!current) {
        return normalizeCallToolResult(undefined, {
          server: mapping.serverName,
          tool: mapping.nativeName,
          transportError: `MCP tool "${mapping.nativeName}" is no longer available`,
        });
      }
      if (!this.invokeHandler) {
        return normalizeCallToolResult(undefined, {
          server: current.serverName,
          tool: current.nativeName,
          transportError: "MCP invocation is not wired",
        });
      }
      return this.invokeHandler(current, params as Record<string, unknown>, signal, ctx);
    };

    pi.registerTool({
      name: piName,
      label: mapping.label,
      description: mapping.description ?? `MCP tool ${mapping.nativeName}`, 
      parameters: mapping.parameters as never,
      execute: invoke,
    });
  }
}

function identityKey(serverName: string, nativeName: string): string {
  return `${serverName}\u0000${nativeName}`;
}

function toolDescription(entry: McpToolSnapshotEntry): string {
  const native = entry.description?.trim() ? String(entry.description).trim() : "";
  return [
    `MCP tool "${entry.nativeName}" from server "${entry.serverName}".`,
    ...(native ? [native] : []),
    "Execute this tool to call the remote MCP server.",
  ].join(" ");
}