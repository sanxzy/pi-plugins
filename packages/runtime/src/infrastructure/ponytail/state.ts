import { existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  PONYTAIL_BACKUP_PREFIX,
  PONYTAIL_BACKUP_SUFFIX,
  PONYTAIL_FILE_NAME,
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

/**
 * Versioned session Ponytail state. The exact shape is part of the contract:
 * `version: 1`, an explicit boolean `enabled`, and a ticket array.
 */
export interface PonytailState {
  readonly version: 1;
  readonly enabled: boolean;
  readonly tickets: PonytailTicket[];
}

/** The dedicated session-keyed Ponytail state file under the pi-c2 home. */
function sessionStateDir(sessionId: string): string {
  return dirname(homePonytailStateFile(sessionId));
}

function parseTicketRecord(raw: unknown): PonytailTicket | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.value !== "string" || record.value.length === 0) return undefined;
  if (!Array.isArray(record.scopes) || !record.scopes.every((scope): scope is string => typeof scope === "string" && isAbsolutePath(scope))) {
    return undefined;
  }
  if (typeof record.createdAt !== "number" || !Number.isSafeInteger(record.createdAt)) return undefined;
  if (typeof record.expiresAt !== "number" || !Number.isSafeInteger(record.expiresAt)) return undefined;
  return {
    value: record.value,
    scopes: [...record.scopes],
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

function parseState(raw: unknown): PonytailState | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const state = raw as Record<string, unknown>;
  if (state.version !== 1) return undefined;
  if (typeof state.enabled !== "boolean") return undefined;
  if (!Array.isArray(state.tickets)) return undefined;
  const tickets: PonytailTicket[] = [];
  for (const ticket of state.tickets) {
    const parsed = parseTicketRecord(ticket);
    if (!parsed) return undefined;
    tickets.push(parsed);
  }
  return { version: 1, enabled: state.enabled, tickets };
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/");
}

/** List numbered backups in ascending order, ignoring malformed names. */
function listBackups(sessionId: string): string[] {
  const directory = sessionStateDir(sessionId);
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  const backups: string[] = [];
  for (const entry of entries) {
    const match = /^ponytail\.(\d{3})\.json\.bak$/.exec(entry);
    if (!match) continue;
    backups.push(join(directory, entry));
  }
  backups.sort();
  return backups;
}

/**
 * Validate the current wall-clock expiry of every ticket. Tickets whose
 * `expiresAt` has passed never authorize an operation.
 */
export function pruneExpiredTickets(state: PonytailState, nowMs: number): PonytailState {
  const tickets = state.tickets.filter((ticket) => ticket.expiresAt > nowMs);
  return tickets.length === state.tickets.length ? state : { ...state, tickets };
}

/**
 * Atomically persist one session's Ponytail state with owner-only
 * permissions. Publication replaces the prior file; a failed write leaves
 * the previous usable state untouched.
 */
export function writePonytailState(sessionId: string, state: PonytailState): void {
  writePrivateJson(homePonytailStateFile(sessionId), state);
}

/**
 * Load and validate one session's Ponytail state. Malformed, unsupported,
 * or unreadable state never authorizes: the corrupt primary is preserved as
 * the lowest unused numbered backup, the newest valid backup's complete
 * unexpired state is recovered, and recovery fails closed when preservation
 * fails. Missing state returns undefined.
 */
export function loadPonytailState(sessionId: string, nowMs: number): PonytailState | undefined {
  const statePath = homePonytailStateFile(sessionId);
  if (!existsSync(statePath)) return undefined;
  let parsed: PonytailState | undefined;
  try {
    parsed = parseState(readPrivateJson<unknown>(statePath));
  } catch {
    parsed = undefined;
  }
  if (parsed) {
    return pruneExpiredTickets(parsed, nowMs);
  }
  const directory = sessionStateDir(sessionId);
  const backups = listBackups(sessionId);
  let recovery: PonytailState | undefined;
  for (let index = backups.length - 1; index >= 0; index -= 1) {
    try {
      const candidate = parseState(readPrivateJson<unknown>(backups[index]!));
      if (candidate) {
        recovery = pruneExpiredTickets(candidate, nowMs);
        break;
      }
    } catch {
      // Corrupt backups are skipped in descending order.
    }
  }
  const backupName = nextBackupName(directory);
  try {
    renameSync(statePath, join(directory, backupName));
  } catch {
    return undefined;
  }
  const recovered = recovery ?? { version: 1, enabled: true, tickets: [] };
  writePonytailState(sessionId, recovered);
  return recovered;
}

/** The lowest unused three-digit backup name, starting at `001`. */
function nextBackupName(directory: string): string {
  const existing = new Set<string>();
  try {
    for (const entry of readdirSync(directory)) existing.add(entry);
  } catch {
    // A missing directory has no conflicting backups.
  }
  for (let number = 1; number < 1_000; number += 1) {
    const name = `${PONYTAIL_BACKUP_PREFIX}${String(number).padStart(3, "0")}${PONYTAIL_BACKUP_SUFFIX}`;
    if (!existing.has(name)) return name;
  }
  throw new Error("No Ponytail backup slot available");
}

/** True when a private owner-only Ponytail state file exists for the session. */
export function ponytailStateExists(sessionId: string): boolean {
  const statePath = homePonytailStateFile(sessionId);
  try {
    return existsSync(statePath) && statSync(statePath).isFile();
  } catch {
    return false;
  }
}
