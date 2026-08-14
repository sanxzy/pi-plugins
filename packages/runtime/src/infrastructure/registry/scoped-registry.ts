import { existsSync, readdirSync, mkdirSync, type Dirent } from "node:fs";
import { basename, join } from "node:path";
import type { Job, JobUpdate } from "@xzy-ai/core";
import { createRegistry, type Registry } from "./registry.ts";
import {
  runtimeDir,
  scopedRegistryFile,
  scopedSessionsDir,
  sessionDir,
} from "../../shared/paths.ts";

/**
 * Session-scoped registry over the recursive per-live-session layout.
 *
 * Each direct parent owns one append-only registry in its session directory.
 * The registry folds only `jobs-<session-id>.jsonl` files below the scoped
 * sessions tree; there is no flat legacy store.
 */
export interface ScopedRegistry extends Registry {
  readonly projectRoot: string;
  /** Create the folder for a live session without requiring a job record. */
  ensureSession(sessionId: string): void;
  /** Return the registry file that owns a job's direct-parent record. */
  fileForJob(jobId: string): string | undefined;
  /** Return all per-parent registries discovered below the scoped tree. */
  registries(): ReadonlyMap<string, Registry>;
}

function registrySessionId(filePath: string): string {
  const directory = basename(join(filePath, ".."));
  return directory;
}

function discoverScopedFiles(projectRoot: string): string[] {
  const root = scopedSessionsDir(projectRoot);
  if (!existsSync(root)) return [];
  const result: string[] = [];
  const visit = (directory: string): void => {
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" }) as Dirent<string>[];
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && entry.name.startsWith("jobs-") && entry.name.endsWith(".jsonl")) {
        result.push(path);
      }
    }
  };
  visit(root);
  return result;
}

export function createScopedRegistry(projectRoot: string, rootSessionId?: string): ScopedRegistry {
  const byParent = new Map<string, Registry>();
  const ownerByJob = new Map<string, string>();
  const index = new Map<string, Job>();

  const load = (): void => {
    byParent.clear();
    ownerByJob.clear();
    index.clear();
    for (const filePath of discoverScopedFiles(projectRoot)) {
      const parentSessionId = registrySessionId(filePath);
      const registry = createRegistry(filePath, projectRoot);
      byParent.set(parentSessionId, registry);
      for (const [jobId, job] of registry.all()) {
        index.set(jobId, job);
        ownerByJob.set(jobId, parentSessionId);
      }
    }
  };

  load();

  const ensureSession = (sessionId: string): void => {
    mkdirSync(sessionDir(projectRoot, sessionId), { recursive: true });
  };

  const registryForParent = (parentSessionId: string): Registry => {
    ensureSession(parentSessionId);
    let registry = byParent.get(parentSessionId);
    if (!registry) {
      registry = createRegistry(scopedRegistryFile(projectRoot, parentSessionId), projectRoot);
      byParent.set(parentSessionId, registry);
    }
    return registry;
  };

  return {
    projectRoot,
    get filePath(): string {
      return runtimeDir(projectRoot);
    },
    append(event): void {
      const job = event.type === "created" ? event.job : index.get(event.jobId);
      const parentSessionId = job?.parentSessionId;
      if (!parentSessionId) return;
      const registry = registryForParent(parentSessionId);
      registry.append(event);
      registry.prune();
      load();
    },
    createJob(job): void {
      const parentSessionId = job.parentSessionId ?? rootSessionId;
      if (!parentSessionId) {
        throw new Error(`Cannot scope job ${job.jobId} without a parent session id`);
      }
      const next = job.parentSessionId === undefined ? { ...job, parentSessionId } : job;
      registryForParent(parentSessionId).createJob(next);
      // The parent registry may have pruned history; reload so the index agrees
      // with the on-disk (and per-agent-capped) state.
      load();
    },
    updateJob(jobId, update): void {
      const parentSessionId = ownerByJob.get(jobId) ?? index.get(jobId)?.parentSessionId;
      if (!parentSessionId) return;
      registryForParent(parentSessionId).updateJob(jobId, update);
      // The parent registry may have pruned history; reload so the index agrees
      // with the on-disk (and per-agent-capped) state.
      load();
    },
    fold(): Map<string, Job> {
      load();
      return index;
    },
    get(jobId): Job | undefined {
      return index.get(jobId);
    },
    all(): Map<string, Job> {
      return index;
    },
    prune(): void {
      for (const registry of byParent.values()) registry.prune();
      load();
    },
    ensureSession,
    fileForJob(jobId): string | undefined {
      return ownerByJob.has(jobId) ? scopedRegistryFile(projectRoot, ownerByJob.get(jobId)!) : undefined;
    },
    registries(): ReadonlyMap<string, Registry> {
      return byParent;
    },
  };
}

export function scopedRegistryForSession(projectRoot: string, sessionId: string): Registry {
  return createRegistry(scopedRegistryFile(projectRoot, sessionId), projectRoot);
}
