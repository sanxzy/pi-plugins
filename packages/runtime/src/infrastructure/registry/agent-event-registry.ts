import { existsSync, readdirSync, rmSync, type Dirent } from "node:fs";
import { basename, join } from "node:path";
import type { Job, JobEvent, JobUpdate } from "@xzy-ai/core";
import { canonicalAgentId, createAgentManifestStore, foldAgentEvents, type AgentManifestStore } from "../manifests/manifests.ts";
import { ensurePrivateDirectory, homeProjectDir, homeSessionDirFromRoot, encodeProjectId } from "../../shared/paths.ts";
import { canTransition, isTerminal } from "@xzy-ai/core";

export const MAX_RETAINED_TERMINAL_AGENTS = 25;

export interface AgentEventRegistry {
  readonly projectRoot: string;
  readonly rootSessionId?: string;
  readonly filePath: string;
  append(event: JobEvent): void;
  createJob(job: Job): void;
  updateJob(jobId: string, update: JobUpdate): void;
  fold(): Map<string, Job>;
  get(jobId: string): Job | undefined;
  getBySessionId(sessionId: string): Job | undefined;
  all(): Map<string, Job>;
  prune(): void;
  ensureSession(sessionId: string): void;
  fileForJob(jobId: string): string | undefined;
  registries(): ReadonlyMap<string, AgentManifestStore>;
  /** Refresh the in-memory read model from authoritative home event logs. */
  refresh(): void;
}

interface Entry {
  readonly store: AgentManifestStore;
  readonly job: Job;
}

function agentEventFiles(sessionDir: string): string[] {
  if (!existsSync(sessionDir)) return [];
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
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === "events.jsonl") result.push(path);
    }
  };
  visit(sessionDir);
  return result;
}

function toJob(manifest: NonNullable<ReturnType<typeof foldAgentEvents>>): Job {
  return {
    jobId: manifest.jobId ?? manifest.agentId,
    sessionId: manifest.piSessionId ?? manifest.jobId ?? manifest.agentId,
    parentSessionId: manifest.parentSessionId,
    parentAgentIds: manifest.parentAgentIds,
    status: manifest.status,
    description: manifest.description,
    subagentType: manifest.subagentType,
    parentJobId: manifest.parentJobId,
    rootJobId: manifest.rootAgentId,
    depth: manifest.depth,
    sessionFile: manifest.sessionFile,
    delivered: manifest.delivered,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
  };
}

export function canonicalJobId(jobId: string): string {
  return canonicalAgentId(jobId);
}

export function createAgentEventRegistry(projectRoot: string, rootSessionId?: string): AgentEventRegistry {
  const byJob = new Map<string, Entry>();
  const stores = new Map<string, AgentManifestStore>();
  let nextSequence = 0;
  const projectId = encodeProjectId(projectRoot);

  const load = (): void => {
    byJob.clear();
    stores.clear();
    const sessionsRoot = join(homeProjectDir(projectId), "sessions");
    for (const eventsPath of agentEventFiles(sessionsRoot)) {
      const manifest = foldAgentEvents(eventsPath);
      if (!manifest) continue;
      const job = toJob(manifest);
      const agentDir = join(eventsPath, "..");
      const store = createAgentManifestStore({
        projectRoot,
        rootSessionId: manifest.rootSessionId,
        jobId: manifest.jobId,
        piSessionId: manifest.piSessionId,
        parentAgentIds: [...manifest.parentAgentIds],
        parentJobId: manifest.parentJobId,
        parentSessionId: manifest.parentSessionId,
        rootAgentId: manifest.rootAgentId,
        depth: manifest.depth,
        sessionFile: manifest.sessionFile,
        sequence: manifest.sequence,
        now: manifest.createdAt,
      });
      byJob.set(job.jobId, { store, job });
      stores.set(job.jobId, store);
      // The event log is authoritative; this also rebuilds a missing or stale snapshot.
      store.read();
      nextSequence = Math.max(nextSequence, (manifest.sequence ?? nextSequence) + 1);
      void agentDir;
    }
  };

  const storeFor = (job: Job): AgentManifestStore => {
    const id = canonicalAgentId(job.jobId);
    const existing = stores.get(id);
    if (existing) return existing;
    const parent = job.parentJobId ? byJob.get(canonicalAgentId(job.parentJobId))?.job : undefined;
    const parentIds: string[] = [];
    let ancestor = parent;
    while (ancestor) {
      parentIds.unshift(ancestor.jobId);
      ancestor = ancestor.parentJobId ? byJob.get(canonicalAgentId(ancestor.parentJobId))?.job : undefined;
    }
    const store = createAgentManifestStore({
      projectRoot,
      rootSessionId: rootSessionId ?? job.parentSessionId ?? "unknown-root",
      jobId: job.jobId,
      piSessionId: job.sessionId,
      parentAgentIds: parentIds,
      parentJobId: job.parentJobId,
      parentSessionId: job.parentSessionId,
      rootAgentId: job.rootJobId,
      depth: job.depth,
      sessionFile: job.sessionFile,
      sequence: nextSequence++,
      now: job.createdAt,
    });
    stores.set(id, store);
    return store;
  };

  const reload = (): void => load();
  load();

  const prune = (): void => {
    // The home event logs are authoritative even while the process singleton
    // survives an extension reload. Refresh before pruning so externally
    // removed agent directories cannot remain visible in memory.
    load();
    const jobs = [...byJob.values()].map((entry) => entry.job);
    const byParent = new Map<string, Job[]>();
    for (const job of jobs) {
      const parent = job.parentSessionId ?? "";
      const group = byParent.get(parent) ?? [];
      group.push(job);
      byParent.set(parent, group);
    }
    const retained = new Set<string>();
    for (const group of byParent.values()) {
      const terminal = group.filter((job) => isTerminal(job.status));
      for (const job of group) if (!isTerminal(job.status)) retained.add(job.jobId);
      terminal.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.updatedAt.localeCompare(b.updatedAt) || a.jobId.localeCompare(b.jobId));
      for (const job of terminal.slice(-MAX_RETAINED_TERMINAL_AGENTS)) retained.add(job.jobId);
    }
    for (const job of jobs) {
      if (!retained.has(job.jobId)) continue;
      let parentId = job.parentJobId;
      while (parentId) {
        retained.add(parentId);
        parentId = byJob.get(parentId)?.job.parentJobId;
      }
    }
    for (const job of jobs) {
      if (retained.has(job.jobId) || !isTerminal(job.status)) continue;
      const store = byJob.get(job.jobId)?.store;
      if (store) rmSync(store.agentDir, { recursive: true, force: true });
    }
    reload();
  };

  return {
    projectRoot,
    rootSessionId,
    filePath: homeSessionDirFromRoot(projectRoot, rootSessionId ?? "root"),
    append(event): void {
      if (event.type === "created") this.createJob(event.job);
      else this.updateJob(event.jobId, event.update);
    },
    createJob(job): void {
      const cc = (id: string): string => canonicalAgentId(id);
      const normalized = {
        ...job,
        jobId: cc(job.jobId),
        parentJobId: job.parentJobId ? cc(job.parentJobId) : undefined,
        rootJobId: job.rootJobId ? cc(job.rootJobId) : job.jobId,
        parentAgentIds: (job.parentAgentIds ?? []).map(cc),
      };
      const store = storeFor(normalized);
      store.create({ description: normalized.description, subagentType: normalized.subagentType });
      const initialTransitions: Job["status"][] = normalized.status === "created"
        ? []
        : normalized.status === "queued"
          ? ["queued"]
          : normalized.status === "running"
            ? ["queued", "running"]
            : normalized.status === "completed" || normalized.status === "failed"
              ? ["queued", "running", normalized.status]
              : [normalized.status];
      for (const status of initialTransitions) store.update({ status, at: normalized.updatedAt, sessionFile: normalized.sessionFile });
      load();
      prune();
    },
    updateJob(jobId, update): void {
      load();
      const entry = byJob.get(jobId) ?? byJob.get(canonicalAgentId(jobId)) ?? [...byJob.values()].find((e) => canonicalAgentId(e.job.jobId) === canonicalAgentId(jobId));
      if (!entry) return;
      const nextStatus = update.status ?? entry.job.status;
      if (nextStatus !== entry.job.status && !canTransition(entry.job.status, nextStatus)) return;
      entry.store.update({ ...update, status: nextStatus });
      load();
      prune();
    },
    fold(): Map<string, Job> { load(); return new Map([...byJob].sort(([, a], [, b]) => (a.store.read()?.sequence ?? 0) - (b.store.read()?.sequence ?? 0)).map(([id, entry]) => [id, entry.job])); },
    get(jobId): Job | undefined {
      load();
      return byJob.get(jobId)?.job ?? byJob.get(canonicalAgentId(jobId))?.job ?? [...byJob.values()].find((e) => canonicalAgentId(e.job.jobId) === canonicalAgentId(jobId))?.job;
    },
    getBySessionId(sessionId): Job | undefined {
      load();
      return [...byJob.values()].find((entry) => entry.job.sessionId === sessionId || canonicalAgentId(entry.job.sessionId ?? "") === canonicalAgentId(sessionId))?.job;
    },
    all(): Map<string, Job> {
      load();
      return new Map([...byJob].sort(([, a], [, b]) => (a.store.read()?.sequence ?? 0) - (b.store.read()?.sequence ?? 0)).map(([id, entry]) => [id, entry.job]));
    },
    prune,
    ensureSession(sessionId): void { ensurePrivateDirectory(homeSessionDirFromRoot(projectRoot, sessionId)); },
    fileForJob(jobId): string | undefined {
      const job = byJob.get(jobId)?.job ?? byJob.get(canonicalAgentId(jobId))?.job ?? [...byJob.values()].find((e) => canonicalAgentId(e.job.jobId) === canonicalAgentId(jobId))?.job;
      return job ? byJob.get(job.jobId)?.store.eventsPath : undefined;
    },
    registries(): ReadonlyMap<string, AgentManifestStore> {
      load();
      return stores;
    },
    refresh(): void { load(); },
  };
}
