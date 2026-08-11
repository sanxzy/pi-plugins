import { createHash } from "node:crypto";

/** Longest allowed slug segment; longer names are truncated. */
const MAX_SLUG_LENGTH = 40;

/**
 * Deterministic, collision-safe naming for model-facing MCP tool names.
 *
 * Every MCP `server/tool` pair maps to a stable Pi tool name of the form
 * `server_tool`. The first identity to claim a normalized base keeps it; any
 * later identity whose normalized form collides (same server slug + tool slug)
 * receives a deterministic short SHA-256 suffix derived from the full native
 * identity. Suffixes keep names stable across refreshes and sessions.
 */

/** Normalize a server/tool segment into a safe, bounded slug. */
export function slugify(input: string): string {
  const normalized = input.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized) return "server";
  return normalized.length > MAX_SLUG_LENGTH ? normalized.slice(0, MAX_SLUG_LENGTH) : normalized;
}

/** Build the base `server_tool` Pi name for a native identity. */
export function serverToolPiName(serverName: string, nativeName: string): string {
  return `${slugify(serverName)}_${slugify(nativeName)}`;
}

/** Deterministic short suffix derived from the full native identity. */
export function collisionSuffix(serverName: string, nativeName: string, length = 8): string {
  return createHash("sha256").update(`${serverName}\u0000${nativeName}`).digest("hex").slice(0, length);
}

/**
 * Stateful name registry that keeps stable, deterministic names for native MCP
 * identities while resolving collisions against Pi-built-ins and other servers.
 */
export class NameRegistry {
  private readonly assigned = new Map<string, string>();
  private readonly allocated = new Set<string>();
  constructor(private readonly reserved: ReadonlySet<string> = new Set()) {}

  /**
   * Resolve (or allocate) the stable Pi name for a native identity. `occupied`
   * is the set of names already claimed by other identities in the same call.
   */
  resolve(serverName: string, nativeName: string, occupied = new Set<string>()): string {
    const identityKey = builtin(serverName, nativeName);
    const existing = this.assigned.get(identityKey);
    if (existing) return existing;

    const base = serverToolPiName(serverName, nativeName);
    const candidate = this.uniquify(base, serverName, nativeName, occupied);
    this.assigned.set(identityKey, candidate);
    this.allocated.add(candidate);
    occupied.add(candidate);
    return candidate;
  }

  private uniquify(
    base: string,
    serverName: string,
    nativeName: string,
    occupied: Set<string>,
  ): string {
    const taken = (name: string): boolean =>
      this.reserved.has(name) || this.allocated.has(name) || occupied.has(name);
    if (!taken(base)) return base;
    const short = `${base}_${collisionSuffix(serverName, nativeName, 8)}`;
    if (!taken(short)) return short;
    // Extremely unlikely double collision; lengthen the digest deterministically.
    return `${base}_${collisionSuffix(serverName, nativeName, 16)}`;
  }
}

/** One-shot name resolution using a caller-supplied occupied set. */
export function resolvePiName(
  occupied: Set<string> | ReadonlySet<string>,
  serverName: string,
  nativeName: string,
): string {
  const registry = new NameRegistry(new Set(occupied));
  return registry.resolve(serverName, nativeName, new Set(occupied));
}

function builtin(serverName: string, nativeName: string): string {
  return `${serverName}\u0000${nativeName}`;
}
