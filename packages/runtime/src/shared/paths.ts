import { join } from "node:path";

/**
 * Project-local session-scoped runtime paths for pi-code.
 *
 * New state lives below `<project>/.pi/pi-code/sessions/<live-session-id>/`.
 * Each live session owns its child transcripts and append-only job registry.
 */
export const RUNTIME_DIR_NAME = "pi-code";
export const SESSIONS_DIR_NAME = "sessions";
export const SCOPED_REGISTRY_PREFIX = "jobs-";
export const SCOPED_REGISTRY_SUFFIX = ".jsonl";

export function runtimeDir(projectRoot: string): string {
  return join(projectRoot, ".pi", RUNTIME_DIR_NAME);
}

export function scopedSessionsDir(projectRoot: string): string {
  return join(runtimeDir(projectRoot), SESSIONS_DIR_NAME);
}

function validateSessionId(sessionId: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId)) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
  return sessionId;
}

/** Directory owned by one live parent session. */
export function sessionDir(projectRoot: string, sessionId: string): string {
  return join(scopedSessionsDir(projectRoot), validateSessionId(sessionId));
}

/** Alias used by runtime callers to emphasize child-parent placement. */
export function childSessionDir(projectRoot: string, parentSessionId: string): string {
  return sessionDir(projectRoot, parentSessionId);
}

export function rootSessionDir(projectRoot: string, rootSessionId: string): string {
  return sessionDir(projectRoot, rootSessionId);
}

export function sessionRegistryFile(projectRoot: string, parentSessionId: string): string {
  const id = validateSessionId(parentSessionId);
  return join(sessionDir(projectRoot, id), `${SCOPED_REGISTRY_PREFIX}${id}${SCOPED_REGISTRY_SUFFIX}`);
}

/** Descriptive alias for the per-parent registry path. */
export function scopedRegistryFile(projectRoot: string, parentSessionId: string): string {
  return sessionRegistryFile(projectRoot, parentSessionId);
}

/** Child transcript directory for a live child whose parent is `parentSessionId`. */
export function childTranscriptDir(projectRoot: string, parentSessionId: string): string {
  return childSessionDir(projectRoot, parentSessionId);
}

/** Resolve a deterministic transcript path when callers need one explicitly. */
export function childTranscriptFile(projectRoot: string, parentSessionId: string, jobId: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(jobId)) {
    throw new Error(`Invalid job id: ${jobId}`);
  }
  return join(childTranscriptDir(projectRoot, parentSessionId), `${jobId}.jsonl`);
}

export { validateSessionId as assertSessionId };
