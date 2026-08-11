import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import {
  createAgentEventRegistry,
  finishRootSession,
  encodeProjectId,
  homeProjectDirFromRoot,
  homeSessionDirFromRoot,
  homeSessionManifestFile,
  readSessionManifest,
} from "@xzy-ai/runtime";
import { isProcessAlive } from "./ownership.ts";

interface LockfileModule {
  lockSync(file: string, options?: Record<string, unknown>): () => void;
}
const require = createRequire(import.meta.url);
const lockfileApi = require("proper-lockfile") as LockfileModule;

export const MAX_ROOT_SESSIONS = 200;

export interface CleanupRootSessionsOptions {
  currentPid?: number;
  currentProcessStartTime?: string;
  isAlive?: (pid: number) => boolean;
  now?: string;
}

export interface CleanupRootSessionsResult {
  readonly ok: true;
  readonly reconciled: number;
  readonly interruptedAgents: number;
  readonly removed: number;
  readonly remaining: number;
}

interface SessionEntry {
  readonly sessionId: string;
  readonly path: string;
  active: boolean;
  readonly pid?: number;
  readonly processStartTime?: string;
  readonly lastSeenAt: string;
}

function cleanupLockFile(projectRoot: string): string {
  const projectDir = homeProjectDirFromRoot(projectRoot);
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  const file = join(projectDir, ".sessions.cleanup.lock");
  writeFileSync(file, "lock\n", { flag: "a", mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

function discoverSessions(projectRoot: string): SessionEntry[] {
  const sessionsDir = join(homeProjectDirFromRoot(projectRoot), "sessions");
  if (!existsSync(sessionsDir)) return [];
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(sessionsDir, { withFileTypes: true, encoding: "utf8" }) as Dirent<string>[];
  } catch {
    return [];
  }
  const sessions: SessionEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionId = entry.name;
    const manifestPath = homeSessionManifestFile(encodeProjectId(projectRoot), sessionId);
    try {
      const manifest = readSessionManifest(projectRoot, sessionId);
      sessions.push({
        sessionId,
        path: homeSessionDirFromRoot(projectRoot, sessionId),
        active: manifest.active,
        pid: manifest.pid,
        processStartTime: manifest.processStartTime,
        lastSeenAt: manifest.lastSeenAt,
      });
    } catch {
      // A malformed session is not eligible for destructive cleanup. It is
      // retained for fail-closed operator inspection.
      void manifestPath;
    }
  }
  return sessions;
}

export function cleanupRootSessions(
  projectRoot: string,
  options: CleanupRootSessionsOptions = {},
): CleanupRootSessionsResult | { readonly ok: false; readonly message: string } {
  const currentPid = options.currentPid ?? process.pid;
  const currentProcessStartTime = options.currentProcessStartTime;
  const checkAlive = options.isAlive ?? isProcessAlive;
  let release: (() => void) | undefined;
  try {
    release = lockfileApi.lockSync(cleanupLockFile(projectRoot), {
      realpath: false,
      stale: 10_000,
      update: 5_000,
      retries: 0,
    });
    const sessions = discoverSessions(projectRoot);
    let reconciled = 0;
    let interruptedAgents = 0;
    for (const session of sessions) {
      if (!session.active) continue;
      const sameProcess = session.pid === currentPid && session.processStartTime === currentProcessStartTime;
      const alive = session.pid !== undefined && checkAlive(session.pid);
      if (sameProcess || alive) continue;
      const registry = createAgentEventRegistry(projectRoot, session.sessionId);
      for (const job of registry.all().values()) {
        if (job.status !== "running") continue;
        registry.updateJob(job.jobId, { status: "interrupted" });
        interruptedAgents += 1;
      }
      finishRootSession({ projectRoot, sessionId: session.sessionId, reason: "liveness-reconciliation", now: options.now });
      session.active = false;
      reconciled += 1;
    }

    const refreshed = discoverSessions(projectRoot);
    const active = refreshed.filter((session) => session.active);
    const inactive = refreshed
      .filter((session) => !session.active)
      .sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt) || a.sessionId.localeCompare(b.sessionId));
    const removeCount = Math.max(0, refreshed.length - MAX_ROOT_SESSIONS);
    const removable = active.length > MAX_ROOT_SESSIONS ? 0 : removeCount;
    for (const session of inactive.slice(0, removable)) {
      rmSync(session.path, { recursive: true, force: true });
    }
    return { ok: true, reconciled, interruptedAgents, removed: Math.min(removable, inactive.length), remaining: refreshed.length - Math.min(removable, inactive.length) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Unable to clean root sessions" };
  } finally {
    try { release?.(); } catch { /* cleanup lock release is best effort */ }
  }
}
