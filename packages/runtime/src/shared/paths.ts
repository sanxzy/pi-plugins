import { join } from "node:path";

/**
 * Project-local runtime paths for pi-code.
 *
 * All orchestrator runtime state lives under `<project>/.pi/pi-code/`:
 * - `jobs.jsonl` — append-only job registry
 * - `sessions/`   — child session transcripts (added in a later phase)
 *
 * These paths are derived only from the resolved project root; a model-supplied
 * id is never concatenated into a path.
 */
export const RUNTIME_DIR_NAME = "pi-code";
export const REGISTRY_FILE_NAME = "jobs.jsonl";
export const SESSIONS_DIR_NAME = "sessions";

export function runtimeDir(projectRoot: string): string {
  return join(projectRoot, ".pi", RUNTIME_DIR_NAME);
}

export function registryFile(projectRoot: string): string {
  return join(runtimeDir(projectRoot), REGISTRY_FILE_NAME);
}

export function sessionsDir(projectRoot: string): string {
  return join(runtimeDir(projectRoot), SESSIONS_DIR_NAME);
}
