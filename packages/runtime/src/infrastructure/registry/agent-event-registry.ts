import { existsSync, readdirSync, rmSync, type Dirent } from "node:fs";
import { basename, join } from "node:path";
import { updateJob as applyJobUpdate, type Job, type JobEvent, type JobUpdate } from "@xzy-ai/core";
import { canonicalAgentId, createAgentManifestStore, foldAgentEvents, type AgentManifestStore } from "../manifests/manifests.ts";
import { ensurePrivateDirectory, homeProjectDir, homeSessionDirFromRoot, encodeProjectId } from "../../shared/paths.ts";
import { canTransition, isTerminal } from "@xzy-ai/core";
import { REGISTRY_OPERATIONS, processWithLog } from "@xzy-ai/observability";

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
  /** Return the current in-memory read model without touching home storage. */
  snapshot(): ReadonlyMap<string, Job>;
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
  /** Stable ordering key for this record, from its persisted manifest sequence. */
  readonly sequence: number;
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
  let snapshot = new Map<string, Job>() as ReadonlyMap<string, Job>;
  const projectId = encodeProjectId(projectRoot);

  const load = (): void => {
    processWithLog({ operation: REGISTRY_OPERATIONS.AGENT_LOAD, parameters: { projectRoot } }, () => {
    byJob.clear();
    stores.clear();
    const sessionsRoot = join(homeProjectDir(projectId), "sessions");
    for (const eventsPath of agentEventFiles(sessionsRoot)) {
      const manifest = foldAgentEvents(eventsPath);
      if (!manifest) continue;
      const job = toJob(manifest);
      const sequence = manifest.sequence ?? nextSequence++;
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
      byJob.set(job.jobId, { store, job, sequence });
      stores.set(job.jobId, store);
      // The event log is authoritative; this also rebuilds a missing or stale snapshot.
      store.read();
      nextSequence = Math.max(nextSequence, sequence + 1);
      void agentDir;
    }
    snapshot = new Map([...byJob].map(([id, entry]) => [id, entry.job]));
    });
  };

  const storeFor = (job: Job, sequence?: number): AgentManifestStore => {
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
      sequence: sequence ?? nextSequence++,
      now: job.createdAt,
    });
    stores.set(id, store);
    return store;
  };

  load();

  const publish = (): void => {
    snapshot = new Map([...byJob].map(([id, entry]) => [id, entry.job]));
  };

  const sortedJobs = (): Map<string, Job> => new Map(
    [...byJob]
      .sort(([, a], [, b]) => a.sequence - b.sequence || a.job.createdAt.localeCompare(b.job.createdAt) || a.job.jobId.localeCompare(b.job.jobId))
      .map(([id, entry]) => [id, entry.job]),
  );

  const findEntry = (jobId: string): Entry | undefined => {
    const canonical = canonicalAgentId(jobId);
    return byJob.get(jobId) ?? byJob.get(canonical) ?? [...byJob.values()].find((entry) => canonicalAgentId(entry.job.jobId) === canonical);
  };

  const prune = (): void => {
    const jobs = [...byJob.values()].map((entry) => entry.job);
    const terminalByParent = new Map<string, number>();
    for (const job of jobs) {
      if (!isTerminal(job.status)) continue;
      const parent = job.parentSessionId ?? "";
      terminalByParent.set(parent, (terminalByParent.get(parent) ?? 0) + 1);
    }
    if (![...terminalByParent.values()].some((count) => count > MAX_RETAINED_TERMINAL_AGENTS)) return;

    processWithLog({ operation: REGISTRY_OPERATIONS.AGENT_PRUNE, parameters: { projectRoot } }, () => {
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
    // Refresh only after destructive pruning. The normal lifecycle write path
    // remains in-memory-first; this reload removes pruned records and repairs
    // the snapshot after external directories have been deleted.
    load();
    });
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
      processWithLog({ operation: REGISTRY_OPERATIONS.AGENT_CREATE, parameters: { jobId: job.jobId } }, () => {
      const cc = (id: string): string => canonicalAgentId(id);
      const normalized: Job = {
        ...job,
        jobId: cc(job.jobId),
        parentJobId: job.parentJobId ? cc(job.parentJobId) : undefined,
        rootJobId: job.rootJobId ? cc(job.rootJobId) : job.jobId,
        parentAgentIds: (job.parentAgentIds ?? []).map(cc),
      };
      const sequence = nextSequence++;
      const store = storeFor(normalized, sequence);
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
      const entry: Entry = { store, job: normalized, sequence };
      byJob.set(normalized.jobId, entry);
      stores.set(normalized.jobId, store);
      // The store has persisted all initial events. Publish the requested final
      // state directly instead of folding every project event log again.
      const finalJob = initialTransitions.reduce<Job>((current, status) => applyJobUpdate(current, { status, sessionFile: normalized.sessionFile, updatedAt: normalized.updatedAt }), normalized);
      byJob.set(normalized.jobId, { ...entry, job: finalJob });
      publish();
      prune();
      });
    },
    updateJob(jobId, update): void {
      processWithLog({ operation: REGISTRY_OPERATIONS.AGENT_UPDATE, parameters: { jobId, status: update.status } }, () => {
      const entry = findEntry(jobId);
      if (!entry) return;
      const nextStatus = update.status ?? entry.job.status;
      if (nextStatus !== entry.job.status && !canTransition(entry.job.status, nextStatus)) return;
      entry.store.update({ ...update, status: nextStatus });
      const nextJob = applyJobUpdate(entry.job, { ...update, status: nextStatus });
      byJob.set(entry.job.jobId, { ...entry, job: nextJob });
      publish();
      prune();
      });
    },
    fold(): Map<string, Job> { return sortedJobs(); },
    get(jobId): Job | undefined {
      return findEntry(jobId)?.job;
    },
    getBySessionId(sessionId): Job | undefined {
      return [...byJob.values()].find((entry) => entry.job.sessionId === sessionId || canonicalAgentId(entry.job.sessionId ?? "") === canonicalAgentId(sessionId))?.job;
    },
    all(): Map<string, Job> {
      return sortedJobs();
    },
    snapshot(): ReadonlyMap<string, Job> {
      // UI hot path: reads only the already-loaded in-memory model. Lookups
      // (`get`/`getBySessionId`/`all`/`fold`/`registries`) also serve from
      // memory; only explicit `refresh()` rescans the home event logs. Render
      // consumes this stable snapshot; lifecycle writes and `refresh()`
      // publish a fresh reference. The returned map is the shared snapshot,
      // not a per-call copy, so rendering allocates nothing.
      return snapshot;
    },
    prune,
    ensureSession(sessionId): void {
      processWithLog({ operation: REGISTRY_OPERATIONS.AGENT_ENSURE_SESSION, parameters: { projectRoot, sessionId } }, () => {
        ensurePrivateDirectory(homeSessionDirFromRoot(projectRoot, sessionId));
      });
    },
    fileForJob(jobId): string | undefined {
      const entry = findEntry(jobId);
      return entry?.store.eventsPath;
    },
    registries(): ReadonlyMap<string, AgentManifestStore> {
      return stores;
    },
    refresh(): void { load(); },
  };
}
