import { existsSync, readdirSync, realpathSync, renameSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  PONYTAIL_BACKUP_PREFIX,
  PONYTAIL_BACKUP_SUFFIX,
  homePonytailStateFile,
  readPrivateJson,
  writePrivateJson,
} from "../../shared/paths.ts";

/** One persisted authorization record. */
export interface PonytailTicket {
  readonly value: string;
  readonly scopes: readonly string[];
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** Versioned session Ponytail state. */
export interface PonytailState {
  readonly version: 1;
  readonly enabled: boolean;
  readonly tickets: PonytailTicket[];
}

/** Optional file-operation seam used by deterministic recovery tests. */
export interface PonytailPersistence {
  readonly readJson: (filePath: string) => unknown;
  readonly writeJson: (filePath: string, value: unknown) => void;
  readonly rename: (from: string, to: string) => void;
  readonly list: (directory: string) => string[];
  readonly exists: (filePath: string) => boolean;
}

const defaultPersistence: PonytailPersistence = {
  readJson: (filePath) => readPrivateJson<unknown>(filePath),
  writeJson: (filePath, value) => writePrivateJson(filePath, value),
  rename: (from, to) => renameSync(from, to),
  list: (directory) => readdirSync(directory),
  exists: (filePath) => existsSync(filePath),
};

/** Dedicated session-keyed state file directory. */
function sessionStateDir(sessionId: string): string {
  return dirname(homePonytailStateFile(sessionId));
}

/**
 * Canonicalize an absolute stored scope without mutating the filesystem. An
 * existing path must equal its real path. A missing path is canonical only when
 * its nearest existing ancestor resolves to the same lexical location; this
 * rejects traversal and symlink escapes while allowing future directories.
 */
export function canonicalPonytailScope(scope: string): string | undefined {
  if (!isAbsolute(scope)) return undefined;
  const resolved = resolve(scope);
  if (resolved !== scope) return undefined;
  let ancestor = resolved;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return undefined;
    ancestor = parent;
  }
  let canonicalAncestor: string;
  try {
    canonicalAncestor = realpathSync(ancestor);
  } catch {
    return undefined;
  }
  const suffix = relative(ancestor, resolved);
  const canonical = resolve(canonicalAncestor, suffix);
  return canonical === resolved ? resolved : undefined;
}

function parseTicketRecord(raw: unknown): PonytailTicket | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.value !== "string" || record.value.length === 0) return undefined;
  if (!Array.isArray(record.scopes) || record.scopes.length === 0) return undefined;
  const scopes: string[] = [];
  for (const scope of record.scopes) {
    if (typeof scope !== "string") return undefined;
    const canonical = canonicalPonytailScope(scope);
    if (canonical === undefined || scopes.includes(canonical)) return undefined;
    scopes.push(canonical);
  }
  if (typeof record.createdAt !== "number" || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0) return undefined;
  if (typeof record.expiresAt !== "number" || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= record.createdAt) return undefined;
  return { value: record.value, scopes, createdAt: record.createdAt, expiresAt: record.expiresAt };
}

function parseState(raw: unknown): PonytailState | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const state = raw as Record<string, unknown>;
  if (state.version !== 1 || typeof state.enabled !== "boolean" || !Array.isArray(state.tickets)) return undefined;
  const tickets: PonytailTicket[] = [];
  for (const ticket of state.tickets) {
    const parsed = parseTicketRecord(ticket);
    if (!parsed) return undefined;
    tickets.push(parsed);
  }
  return { version: 1, enabled: state.enabled, tickets };
}

function listBackups(sessionId: string, persistence: PonytailPersistence): string[] {
  const directory = sessionStateDir(sessionId);
  let entries: string[];
  try {
    entries = persistence.list(directory);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => /^ponytail\.\d{3}\.json\.bak$/.test(entry))
    .sort()
    .map((entry) => join(directory, entry));
}

/** Remove expired records; timestamps are persisted wall-clock milliseconds. */
export function pruneExpiredTickets(state: PonytailState, nowMs: number): PonytailState {
  const tickets = state.tickets.filter((ticket) => ticket.expiresAt > nowMs);
  return tickets.length === state.tickets.length ? state : { ...state, tickets };
}

/** Atomically persist one session's state with owner-only permissions. */
export function writePonytailState(sessionId: string, state: PonytailState): void {
  writePrivateJson(homePonytailStateFile(sessionId), state);
}

/**
 * Serialize asynchronous same-session state mutations. Synchronous callers in
 * one Node turn are already non-interleaving; future ticket creation uses this
 * queue to prevent concurrent read/prune/write cycles from losing records.
 */
const mutationQueues = new Map<string, Promise<void>>();
export function serializePonytailMutation<T>(sessionId: string, mutation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(sessionId) ?? Promise.resolve();
  const current = previous.then(mutation, mutation);
  const settled = current.then(() => undefined, () => undefined);
  mutationQueues.set(sessionId, settled);
  void settled.finally(() => {
    if (mutationQueues.get(sessionId) === settled) mutationQueues.delete(sessionId);
  });
  return current;
}

/**
 * Load and validate state. Corrupt primaries are preserved under the lowest
 * unused backup. If recovery publication fails, the backup is restored to the
 * primary and authorization remains inactive.
 */
export function loadPonytailState(sessionId: string, nowMs: number, persistence: PonytailPersistence = defaultPersistence): PonytailState | undefined {
  const statePath = homePonytailStateFile(sessionId);
  if (!persistence.exists(statePath)) return undefined;
  let parsed: PonytailState | undefined;
  try {
    parsed = parseState(persistence.readJson(statePath));
  } catch {
    parsed = undefined;
  }
  if (parsed) {
    const pruned = pruneExpiredTickets(parsed, nowMs);
    if (pruned !== parsed) {
      try {
        persistence.writeJson(statePath, pruned);
      } catch {
        // Expired records are already excluded from the returned authorization.
      }
    }
    return pruned;
  }

  const directory = sessionStateDir(sessionId);
  const recoveryCandidates = listBackups(sessionId, persistence);
  let recovery: PonytailState | undefined;
  for (let index = recoveryCandidates.length - 1; index >= 0; index -= 1) {
    try {
      const candidate = parseState(persistence.readJson(recoveryCandidates[index]!));
      if (candidate) {
        recovery = pruneExpiredTickets(candidate, nowMs);
        break;
      }
    } catch {
      // Continue to the next newest backup.
    }
  }

  const backupName = nextBackupName(directory, persistence);
  if (backupName === undefined) return undefined;
  const backupPath = join(directory, backupName);
  try {
    persistence.rename(statePath, backupPath);
  } catch {
    return undefined;
  }
  const recovered = recovery ?? { version: 1, enabled: true, tickets: [] };
  try {
    persistence.writeJson(statePath, recovered);
    return recovered;
  } catch {
    try {
      persistence.rename(backupPath, statePath);
    } catch {
      // Keep the preserved backup; either way, no replacement is activated.
    }
    return undefined;
  }
}

function nextBackupName(directory: string, persistence: PonytailPersistence): string | undefined {
  const existing = new Set<string>();
  try {
    for (const entry of persistence.list(directory)) existing.add(entry);
  } catch {
    return undefined;
  }
  for (let number = 1; number < 1_000; number += 1) {
    const name = `${PONYTAIL_BACKUP_PREFIX}${String(number).padStart(3, "0")}${PONYTAIL_BACKUP_SUFFIX}`;
    if (!existing.has(name)) return name;
  }
  return undefined;
}

export function ponytailStateExists(sessionId: string): boolean {
  const statePath = homePonytailStateFile(sessionId);
  try {
    return existsSync(statePath) && statSync(statePath).isFile();
  } catch {
    return false;
  }
}
