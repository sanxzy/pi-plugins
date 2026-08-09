import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Tolerant JSON reader and atomic 0600 writer used by the channel state files.
 *
 * Reads resolve missing or malformed files to `null` so callers fail safe to
 * unconfigured/`tui`. Writes go through a unique temp file in the same
 * directory followed by an atomic rename, so readers never observe a partial
 * file. The channel file is written with mode `0600` to keep the bot token
 * private; the marker file uses the default mode.
 */
export function readJsonFile(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export function writeJsonFileAtomic(path: string, value: unknown, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${path.split(/[\\/]/).pop()}.tmp-${process.pid}-${randomUUID()}`);
  try {
    if (mode === undefined) {
      writeFileSync(temp, JSON.stringify(value, null, 2));
    } else {
      writeFileSync(temp, JSON.stringify(value, null, 2), { mode });
    }
    renameSync(temp, path);
  } finally {
    // Best-effort cleanup when the rename failed (e.g. cross-device or lock).
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      // Ignore cleanup errors; the temp name is unique and harmless.
    }
  }
}
