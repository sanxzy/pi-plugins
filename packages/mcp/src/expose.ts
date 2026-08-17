import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { renderMcpCall, renderMcpResult } from "./render.ts";
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
  "knowledge_search",
  "agent",
  "agent_cancel",
  "agent_status",
  "agent_jobs",
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
  "mcp_resources_list",
  "mcp_resources_read",
]);

export interface McpToolSnapshotEntry {
  /** Configured server name in the effective MCP configuration. */
  serverName: string;
  /** Native MCP tool name as advertised by the server. */
  nativeName: string;
  description?: string;
  inputSchema?: unknown;
}

/** Maximum length for an inlined server description in the registered tool. */
export const MAX_TOOL_DESCRIPTION = 1_000;

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
  private readonly sessionSnapshots = new Map<string, McpToolSnapshotEntry[]>();
  private invokeHandler: McpToolInvokeHandler | undefined;

  private readonly manageActiveTools: boolean;

  constructor(
    private readonly pi: ExtensionAPI,
    options: { reservedToolNames?: Iterable<string>; manageActiveTools?: boolean } = {},
  ) {
    this.manageActiveTools = options.manageActiveTools ?? true;
    const reserved = new Set(options.reservedToolNames ?? DEFAULT_RESERVED_TOOL_NAMES);
    // Reserve every tool the host currently has registered (built-ins plus
    // extension tools) so MCP names never clobber an existing definition.
    try {
      for (const tool of pi.getAllTools()) {
        if (tool && typeof tool.name === "string") reserved.add(tool.name);
      }
    } catch {
      // getAllTools may be unavailable in tests/hosts; fall back to the static list.
    }
    this.registry = new NameRegistry(reserved);
  }

  setInvokeHandler(handler: McpToolInvokeHandler): void {
    this.invokeHandler = handler;
  }

  mapping(piName: string): McpToolMapping | undefined {
    return this.mappings.get(piName);
  }

  mappingForIdentity(serverName: string, nativeName: string): McpToolMapping | undefined {
    const piName = this.byIdentity.get(identityKey(serverName, nativeName));
    return piName ? this.mappings.get(piName) : undefined;
  }

  /** All currently registered mappings (newest revision for each piName). */
  mappingsSnapshot(): McpToolMapping[] {
    return [...this.mappings.values()];
  }

  /** Invoke a mapped MCP tool through the currently configured handler. */
  invokeForSession(
    mapping: McpToolMapping,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<NormalizedDetails>> {
    const current = this.mappings.get(mapping.piName);
    if (!current || !this.invokeHandler) {
      return Promise.resolve(normalizeCallToolResult(undefined, {
        server: mapping.serverName,
        tool: mapping.nativeName,
        transportError: !current ? "MCP tool is no longer available" : "MCP invocation is not wired",
      }));
    }
    return this.invokeHandler(current, args, signal, ctx);
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
    this.sessionSnapshots.clear();
    return this.syncSnapshot(snapshot, revision);
  }

  /** Sync one session into the shared model-facing catalog. */
  syncSession(
    sessionKey: string,
    snapshot: McpToolSnapshotEntry[],
    revision: number,
  ): { added: string[]; updated: string[]; removed: string[] } {
    this.sessionSnapshots.set(sessionKey, [...snapshot]);
    const merged = new Map<string, McpToolSnapshotEntry>();
    for (const entries of this.sessionSnapshots.values()) {
      for (const entry of entries) merged.set(identityKey(entry.serverName, entry.nativeName), entry);
    }
    return this.syncSnapshot([...merged.values()], revision);
  }

  /** Remove a session's catalog without unregistering its Pi definitions. */
  removeSession(sessionKey: string, revision: number): { added: string[]; updated: string[]; removed: string[] } {
    this.sessionSnapshots.delete(sessionKey);
    const merged = new Map<string, McpToolSnapshotEntry>();
    for (const entries of this.sessionSnapshots.values()) {
      for (const entry of entries) merged.set(identityKey(entry.serverName, entry.nativeName), entry);
    }
    return this.syncSnapshot([...merged.values()], revision);
  }

  private syncSnapshot(
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
    // Reconcile the host's active/visible set so only the current snapshot is
    // active: Pi cannot unregister definitions, so removed tools are excluded
    // by deactivation, and tools that return after a removal are reactivated
    // (hosts only auto-activate names on their first registration).
    if (!this.manageActiveTools) return { added, updated, removed };
    try {
      const active = new Set(this.pi.getActiveTools());
      let changed = false;
      for (const piName of removed) {
        if (active.delete(piName)) changed = true;
      }
      for (const piName of next.keys()) {
        if (!active.has(piName)) {
          active.add(piName);
          changed = true;
        }
      }
      if (changed) this.pi.setActiveTools([...active]);
    } catch {
      // Some hosts do not expose active-tool control; ignore.
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
      renderCall: (args, theme, context) => renderMcpCall(mapping.nativeName, mapping.serverName, theme, { ...context, args }),
      renderResult: (result, options, theme, context) => renderMcpResult(mapping.nativeName, result, options, theme, context),
    });
  }
}

function identityKey(serverName: string, nativeName: string): string {
  return `${serverName}\u0000${nativeName}`;
}

function toolDescription(entry: McpToolSnapshotEntry): string {
  const native = (entry.description?.trim() ? String(entry.description).trim() : "").slice(0, MAX_TOOL_DESCRIPTION);
  return [
    `MCP tool "${entry.nativeName}" from server "${entry.serverName}".`,
    ...(native ? [native] : []),
    "Execute this tool to call the remote MCP server.",
  ].join(" ");
}