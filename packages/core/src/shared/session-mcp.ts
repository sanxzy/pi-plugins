import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Session-local MCP tool names shared across the extension composition root so
 * child sessions inherit only the MCP catalog discovered by their own manager.
 *
 * Keyed by the canonical project root + live session id, matching the per-session
 * MCP manager lifecycle. The map lives on globalThis under a symbol so it
 * survives extension factory reloads without a module import cycle.
 */
const KEY = Symbol.for("@xzy-ai/pi-c2:session-mcp-names");
const KNOWN_KEY = Symbol.for("@xzy-ai/pi-c2:known-mcp-names");

type NamesMap = Map<string, Set<string>>;
type McpToolDefinition = { name: string; description: string; parameters: unknown };
type DefinitionsMap = Map<string, Map<string, McpToolDefinition>>;
type McpBridge = {
  invokeTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  listResources(server: string): unknown;
  readResource(server: string, uri: string, signal?: AbortSignal): Promise<unknown>;
};
const DEFINITIONS_KEY = Symbol.for("@xzy-ai/pi-c2:session-mcp-definitions");
const BRIDGES_KEY = Symbol.for("@xzy-ai/pi-c2:session-mcp-bridges");

function namesMap(): NamesMap {
  const root = globalThis as unknown as Record<symbol, NamesMap | undefined>;
  root[KEY] ??= new Map<string, Set<string>>();
  return root[KEY]!;
}

function definitionsMap(): DefinitionsMap {
  const root = globalThis as unknown as Record<symbol, DefinitionsMap | undefined>;
  root[DEFINITIONS_KEY] ??= new Map<string, Map<string, McpToolDefinition>>();
  return root[DEFINITIONS_KEY]!;
}

function bridgesMap(): Map<string, McpBridge> {
  const root = globalThis as unknown as Record<symbol, Map<string, McpBridge> | undefined>;
  root[BRIDGES_KEY] ??= new Map<string, McpBridge>();
  return root[BRIDGES_KEY]!;
}

function knownNames(): Set<string> {
  const root = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  root[KNOWN_KEY] ??= new Set<string>();
  return root[KNOWN_KEY]!;
}

function keyOf(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): string {
  return `${ctx.cwd}\u0000${ctx.sessionManager.getSessionId()}`;
}

/** Publish the current session-scoped MCP model name catalog. */
export function publishSessionMcpNames(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, names: Iterable<string>): void {
  const current = new Set(names);
  for (const name of current) knownNames().add(name);
  namesMap().set(keyOf(ctx), current);
}

/** Read the session-scoped MCP catalog for a child that inherits from this session. */
export function sessionMcpNames(cwd: string, sessionId: string): readonly string[] {
  return [...(namesMap().get(`${cwd}\u0000${sessionId}`) ?? [])];
}

/** Publish dynamic MCP definitions so isolated children can construct them. */
export function publishSessionMcpDefinitions(
  ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
  definitions: Iterable<McpToolDefinition>,
): void {
  definitionsMap().set(keyOf(ctx), new Map([...definitions].map((definition) => [definition.name, definition])));
}

/** Read dynamic MCP definitions inherited by a child session. */
export function sessionMcpDefinitions(cwd: string, sessionId: string): readonly McpToolDefinition[] {
  return [...(definitionsMap().get(`${cwd}\u0000${sessionId}`)?.values() ?? [])];
}

/** Publish a process-local bridge used by isolated child MCP tools. */
export function publishSessionMcpBridge(
  ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
  bridge: McpBridge,
): void {
  bridgesMap().set(keyOf(ctx), bridge);
}

/** Read a bridge for a root/parent session. */
export function sessionMcpBridge(cwd: string, sessionId: string): McpBridge | undefined {
  return bridgesMap().get(`${cwd}\u0000${sessionId}`);
}

/** Remove a process-local bridge when a session tree is disposed. */
export function clearSessionMcpBridge(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): void {
  bridgesMap().delete(keyOf(ctx));
}

/** Drop the catalog when the owning session's MCP lifecycle shuts down. */
export function clearMcpNames(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): void {
  namesMap().delete(keyOf(ctx));
  definitionsMap().delete(keyOf(ctx));
  bridgesMap().delete(keyOf(ctx));
}

/** Union of every registered (or previously registered) MCP name for activation. */
export function allMcpNames(): readonly string[] {
  // Pi cannot unregister definitions. Keep every name ever managed by MCP
  // excluded from generic startup activation; the MCP reconciler explicitly
  // reactivates only current bindings.
  return [...knownNames()];
}

/** Register the session-start/stop broker into a Pi host. */
export function registerMcpSessionBroker(pi: ExtensionAPI): void {
  // The broker only reads/writes the shared map keyed by the Pi context that
  // the registered MCP lifecycle provides; it does not register tools itself.
  void pi;
}

export { KEY as SessionMcpNamesKey };
