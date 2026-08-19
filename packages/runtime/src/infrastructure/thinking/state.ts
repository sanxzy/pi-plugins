import { existsSync, readdirSync, renameSync, statSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  THINKING_BACKUP_PREFIX,
  THINKING_BACKUP_SUFFIX,
  homeThinkingStateFile,
  readPrivateJson,
  writePrivateJson,
} from "../../shared/paths.ts";

export const DEFAULT_THINKING_REQUIRED_TURNS = 3;
export const THINKING_REQUIRED_TURNS_MIN = 1;
export const THINKING_REQUIRED_TURNS_MAX = 10;

/** Versioned session thinking state. */
export interface ThinkingState {
  readonly version: 1;
  readonly enabled: boolean;
  /** Minimum number of deep_think turns required before acting. */
  readonly requiredTurns: number;
  readonly scratchpad: readonly string[];
  readonly scratchpads: Readonly<Record<string, readonly string[]>>;
}

/** Parse and validate requiredTurns within bounds. */
export function parseRequiredTurns(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return undefined;
  if (value < THINKING_REQUIRED_TURNS_MIN || value > THINKING_REQUIRED_TURNS_MAX) return undefined;
  return value;
}

/** Optional file-operation seam used by deterministic recovery tests. */
export interface ThinkingPersistence {
  readonly readJson: (filePath: string) => unknown;
  readonly writeJson: (filePath: string, value: unknown) => void;
  readonly rename: (from: string, to: string) => void;
  readonly list: (directory: string) => string[];
  readonly exists: (filePath: string) => boolean;
  readonly chmod: (filePath: string, mode: number) => void;
}

const defaultPersistence: ThinkingPersistence = {
  readJson: (filePath) => readPrivateJson<unknown>(filePath),
  writeJson: (filePath, value) => writePrivateJson(filePath, value),
  rename: (from, to) => renameSync(from, to),
  list: (directory) => readdirSync(directory),
  exists: (filePath) => existsSync(filePath),
  chmod: (filePath, mode) => chmodSync(filePath, mode),
};

function sessionStateDir(sessionId: string): string {
  return dirname(homeThinkingStateFile(sessionId));
}

function parseState(raw: unknown): ThinkingState | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const state = raw as Record<string, unknown>;
  if (state.version !== 1 || typeof state.enabled !== "boolean") return undefined;
  // requiredTurns optional for migration (default)
  let requiredTurns = DEFAULT_THINKING_REQUIRED_TURNS;
  if (state.requiredTurns !== undefined) {
    const parsed = parseRequiredTurns(state.requiredTurns);
    if (parsed === undefined) return undefined;
    requiredTurns = parsed;
  }
  // scratchpad optional for migration
  let scratchpad: string[] = [];
  if (state.scratchpad !== undefined) {
    if (!Array.isArray(state.scratchpad)) return undefined;
    for (const entry of state.scratchpad) {
      if (typeof entry !== "string") return undefined;
    }
    scratchpad = [...state.scratchpad as string[]];
  }
  let scratchpads: Record<string, string[]> = {};
  if (state.scratchpads !== undefined) {
    if (typeof state.scratchpads !== "object" || state.scratchpads === null || Array.isArray(state.scratchpads)) return undefined;
    const record = state.scratchpads as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (typeof key !== "string" || key.length === 0) return undefined;
      if (!Array.isArray(value)) return undefined;
      const arr: string[] = [];
      for (const item of value) {
        if (typeof item !== "string") return undefined;
        arr.push(item);
      }
      scratchpads[key] = arr;
    }
  }
  // Legacy: if scratchpad has entries but scratchpads empty, keep scratchpad
  return { version: 1, enabled: state.enabled, requiredTurns, scratchpad, scratchpads };
}

function listBackups(sessionId: string, persistence: ThinkingPersistence): string[] {
  const directory = sessionStateDir(sessionId);
  let entries: string[];
  try {
    entries = persistence.list(directory);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => /^thinking\.\d{3}\.json\.bak$/.test(entry))
    .sort()
    .map((entry) => join(directory, entry));
}

function nextBackupName(directory: string, persistence: ThinkingPersistence): string | undefined {
  const existing = new Set<string>();
  try {
    for (const entry of persistence.list(directory)) existing.add(entry);
  } catch {
    return undefined;
  }
  for (let number = 1; number < 1_000; number += 1) {
    const name = `${THINKING_BACKUP_PREFIX}${String(number).padStart(3, "0")}${THINKING_BACKUP_SUFFIX}`;
    if (!existing.has(name)) return name;
  }
  return undefined;
}

/**
 * Serialize asynchronous same-session state mutations.
 */
const mutationQueues = new Map<string, Promise<void>>();
export function serializeThinkingMutation<T>(sessionId: string, mutation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(sessionId) ?? Promise.resolve();
  const current = previous.then(mutation, mutation);
  const settled = current.then(() => undefined, () => undefined);
  mutationQueues.set(sessionId, settled);
  void settled.finally(() => {
    if (mutationQueues.get(sessionId) === settled) mutationQueues.delete(sessionId);
  });
  return current;
}

/** The exact state-file path for one session. */
export function thinkingStatePath(sessionId: string): string {
  return homeThinkingStateFile(sessionId);
}

/** Synchronous full-state publication with owner-only permissions. */
export function writeThinkingState(sessionId: string, state: ThinkingState, persistence: ThinkingPersistence = defaultPersistence): void {
  persistence.writeJson(homeThinkingStateFile(sessionId), state);
}

/**
 * Read-modify-write one session's state under the session-keyed queue.
 */
export async function mutateThinkingState(
  sessionId: string,
  nowMs: number,
  mutation: (state: ThinkingState | undefined) => ThinkingState | undefined,
  persistence: ThinkingPersistence = defaultPersistence,
): Promise<ThinkingState | undefined> {
  return serializeThinkingMutation(sessionId, async () => {
    const current = loadThinkingState(sessionId, nowMs, persistence);
    const next = mutation(current);
    if (next === undefined) return current;
    writeThinkingState(sessionId, next, persistence);
    return next;
  });
}

/**
 * Load and validate state. Corrupt primaries are preserved under the lowest
 * unused backup. If recovery publication fails, the backup is restored to the
 * primary and state remains inactive.
 */
export function loadThinkingState(sessionId: string, nowMs: number, persistence: ThinkingPersistence = defaultPersistence): ThinkingState | undefined {
  const statePath = homeThinkingStateFile(sessionId);
  if (!persistence.exists(statePath)) return undefined;
  let parsed: ThinkingState | undefined;
  try {
    parsed = parseState(persistence.readJson(statePath));
  } catch {
    parsed = undefined;
  }
  if (parsed) {
    return parsed;
  }

  const directory = sessionStateDir(sessionId);
  const recoveryCandidates = listBackups(sessionId, persistence);
  let recovery: ThinkingState | undefined;
  for (let index = recoveryCandidates.length - 1; index >= 0; index -= 1) {
    try {
      const candidate = parseState(persistence.readJson(recoveryCandidates[index]!));
      if (candidate) {
        recovery = candidate;
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
  try {
    persistence.chmod(backupPath, 0o600);
  } catch {
    try {
      persistence.rename(backupPath, statePath);
    } catch {
      // Keep the preserved backup; either way, no replacement is activated.
    }
    return undefined;
  }
  const recovered = recovery ?? { version: 1, enabled: false, requiredTurns: DEFAULT_THINKING_REQUIRED_TURNS, scratchpad: [], scratchpads: {} };
  // For thinking, default recovery when no valid backup is disabled (tool not registered by default).
  // However original ponytail recovered as enabled:true; thinking should recover as disabled to keep tool off.
  // But we will follow similar to ponytail but disabled: either way, caller will see disabled.
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

export function thinkingStateExists(sessionId: string): boolean {
  const statePath = homeThinkingStateFile(sessionId);
  try {
    return existsSync(statePath) && statSync(statePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Initialize a child session's independent thinking state at its start/resume
 * boundary. Only the root's effective enabled bit is inherited; scratchpads are never copied.
 */
export function initializeChildThinkingState(rootSessionId: string, childSessionId: string, nowMs = Date.now()): boolean {
  const root = loadThinkingState(rootSessionId, nowMs);
  if (!root) return false;
  try {
    const child = loadThinkingState(childSessionId, nowMs);
    writeThinkingState(childSessionId, {
      version: 1,
      enabled: root.enabled,
      requiredTurns: root.requiredTurns,
      scratchpad: child?.scratchpad ?? [],
      scratchpads: child?.scratchpads ?? {},
    });
    return root.enabled;
  } catch {
    return false;
  }
}
