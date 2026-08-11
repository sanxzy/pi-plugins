import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Session-local MCP tool names shared across the extension composition root so
 * child sessions inherit only the MCP catalog discovered by their own manager.
 *
 * Keyed by the canonical project root + live session id, matching the per-session
 * MCP manager lifecycle. The map lives on globalThis under a symbol so it
 * survives extension factory reloads without a module import cycle.
 */
const KEY = Symbol.for("@xzy-ai/pi-code:session-mcp-names");
const KNOWN_KEY = Symbol.for("@xzy-ai/pi-code:known-mcp-names");

type NamesMap = Map<string, Set<string>>;

function namesMap(): NamesMap {
  const root = globalThis as unknown as Record<symbol, NamesMap | undefined>;
  root[KEY] ??= new Map<string, Set<string>>();
  return root[KEY]!;
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
export function publishSessionMcpNames(ctx: ExtensionContext, names: Iterable<string>): void {
  const current = new Set(names);
  for (const name of current) knownNames().add(name);
  namesMap().set(keyOf(ctx), current);
}

/** Read the session-scoped MCP catalog for a child that inherits from this session. */
export function sessionMcpNames(cwd: string, sessionId: string): readonly string[] {
  return [...(namesMap().get(`${cwd}\u0000${sessionId}`) ?? [])];
}

/** Drop the catalog when the owning session's MCP lifecycle shuts down. */
export function clearMcpNames(ctx: ExtensionContext): void {
  namesMap().delete(keyOf(ctx));
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
