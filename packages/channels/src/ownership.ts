import lockfile from "proper-lockfile";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { channelOwnerFile } from "./shared/paths.ts";
import { type StateResult } from "./state.ts";

/** Crash-safe per-project connection owner record. */
export interface ChannelOwnerRecord {
  pid: number;
  startedAt: string;
  claimId: string;
}

export interface OwnerRead {
  owner?: ChannelOwnerRecord;
  /** True only when the recorded owner PID is confirmed not alive. */
  stale: boolean;
  error?: StateResult<never>;
}

export interface ChannelOwner {
  readonly projectRoot: string;
  readonly pid: number;
  readonly filePath: string;
  read(): OwnerRead;
  acquire(): StateResult<ChannelOwnerRecord>;
  release(): void;
  get isOwner(): boolean;
}

type ProcessLiveness = (pid: number) => boolean;

interface LockfileModule {
  lockSync(file: string, options?: Record<string, unknown>): () => void;
}

const lockfileApi = lockfile as unknown as LockfileModule;
const LOCK_STALE_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOwner(value: unknown): ChannelOwnerRecord | undefined {
  if (
    !isRecord(value) ||
    !Number.isInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    typeof value.startedAt !== "string" ||
    typeof value.claimId !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(value.claimId)
  ) {
    return undefined;
  }
  return { pid: value.pid as number, startedAt: value.startedAt, claimId: value.claimId };
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function ownerError(message: string): StateResult<never> {
  return { ok: false, code: "invalid", message };
}

function safeOwnerMessage(error: unknown, filePath: string): string {
  if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ELOCKED") {
    const current = readOwnerRecord(filePath);
    if (current) return `Channel is owned by process ${current.pid}`;
    return "Channel connection is owned by another process";
  }
  return "Unable to acquire channel connection ownership";
}

function readOwnerRecord(filePath: string): ChannelOwnerRecord | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    return parseOwner(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return undefined;
  }
}

function writeOwnerRecord(filePath: string, record: ChannelOwnerRecord): StateResult<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
    // The lock is already held, so this rename cannot race another owner.
    // A complete file is published before the owner is exposed to callers.
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, filePath);
    return { ok: true, value: undefined };
  } catch {
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch {
      // The lock lease still protects recovery; cleanup is best-effort.
    }
    return { ok: false, code: "io", message: "Unable to write channel owner record" };
  }
}

export function createChannelOwner(
  projectRoot: string,
  options: { pid?: number; isAlive?: ProcessLiveness } = {},
): ChannelOwner {
  const pid = options.pid ?? process.pid;
  const checkAlive = options.isAlive ?? isProcessAlive;
  const filePath = channelOwnerFile(projectRoot);
  let owned = false;
  let ownedRecord: ChannelOwnerRecord | undefined;
  let releaseLock: (() => void) | undefined;

  const read = (): OwnerRead => {
    const owner = readOwnerRecord(filePath);
    if (!owner) return { stale: false };
    return { owner, stale: owner.pid === pid ? false : !checkAlive(owner.pid) };
  };

  const acquire = (): StateResult<ChannelOwnerRecord> => {
    if (owned && ownedRecord) return { ok: true, value: ownedRecord };
    let release: (() => void) | undefined;
    try {
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
      // proper-lockfile uses atomic mkdir and refreshes the lock mtime while
      // held; stale takeover is possible only after the original process dies
      // and its lease stops refreshing.
      release = lockfileApi.lockSync(filePath, {
        realpath: false,
        stale: LOCK_STALE_MS,
        update: LOCK_STALE_MS / 2,
        retries: 0,
      });
    } catch (error) {
      return ownerError(safeOwnerMessage(error, filePath));
    }

    const current = readOwnerRecord(filePath);
    if (current && current.pid !== pid && checkAlive(current.pid)) {
      release();
      return ownerError(`Channel is owned by process ${current.pid}`);
    }

    const record: ChannelOwnerRecord = { pid, startedAt: new Date().toISOString(), claimId: randomUUID() };
    const written = writeOwnerRecord(filePath, record);
    if (!written.ok) {
      release();
      return written;
    }
    owned = true;
    ownedRecord = record;
    releaseLock = release;
    return { ok: true, value: record };
  };

  const release = (): void => {
    if (!owned || !ownedRecord) return;
    const current = readOwnerRecord(filePath);
    if (current?.claimId === ownedRecord.claimId) {
      try {
        unlinkSync(filePath);
      } catch {
        // Keep the lock lease until its release function runs; the mtime lease
        // prevents another process from taking it before we release.
      }
    }
    try {
      releaseLock?.();
    } catch {
      // proper-lockfile release is idempotent from this boundary's perspective.
    }
    owned = false;
    ownedRecord = undefined;
    releaseLock = undefined;
  };

  return { projectRoot, pid, filePath, read, acquire, release, get isOwner() { return owned; } };
}
