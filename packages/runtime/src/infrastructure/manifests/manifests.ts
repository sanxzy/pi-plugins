import { appendFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import type { JobStatus } from "@xzy-ai/core";
import {
  AGENT_MANIFEST_FILE_NAME,
  EVENTS_FILE_NAME,
  canonicalProjectRoot,
  encodeProjectId,
  homeAgentDir,
  homeAgentEventsFile,
  homeAgentManifestFile,
  homeProjectDir,
  homeProjectManifestFile,
  homeSessionDir,
  homeSessionManifestFile,
  ensurePrivateDirectory,
  readPrivateJson,
  writePrivateJson,
  writePrivateText,
} from "../../shared/paths.ts";

/** Canonical agent id for storage: strip a `job-` prefix from a job id. */
export function canonicalAgentId(jobId: string): string {
  return jobId.replace(/^job-/, "");
}

/**
 * Persisted project manifest.
 *
 * Records the canonical project root and lifecycle timestamps. It is project
 * scoped and never removed by root-session cleanup.
 */
export interface ProjectManifest {
  readonly canonicalRoot: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Create or refresh the private project manifest, returning its path and value. */
export function writeProjectManifest(projectRoot: string, now = new Date().toISOString()): {
  readonly path: string;
  readonly manifest: ProjectManifest;
} {
  const canonicalRoot = canonicalProjectRoot(projectRoot);
  const projectId = encodeProjectId(canonicalRoot);
  const path = homeProjectManifestFile(projectId);
  const existing = existsSync(path) ? readProjectManifestFromPath(path) : undefined;
  const manifest: ProjectManifest = {
    canonicalRoot,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  writePrivateJson(path, manifest);
  return { path, manifest };
}

/** Read the project manifest for a project root, failing closed on corruption. */
export function readProjectManifest(projectRoot: string): ProjectManifest {
  const path = homeProjectManifestFile(encodeProjectId(projectRoot));
  return readProjectManifestFromPath(path);
}

function readProjectManifestFromPath(path: string): ProjectManifest {
  return readPrivateJson<ProjectManifest>(path);
}

/**
 * Persisted root-session manifest.
 *
 * `active` reflects the lifecycle; liveness reconciliation later compares
 * `pid` against `processStartTime`. Only sessions that are active may keep
 * running agents.
 */
export interface SessionManifest {
  readonly sessionId: string;
  readonly sessionFile?: string;
  active: boolean;
  readonly canonicalRoot: string;
  pid?: number;
  processStartTime?: string;
  startedAt: string;
  endedAt?: string;
  lastSeenAt: string;
}

export interface StartRootSessionInput {
  projectRoot: string;
  sessionId: string;
  sessionFile?: string;
  pid?: number;
  processStartTime?: string;
  now?: string;
}

export interface StartRootSessionResult {
  readonly manifest: SessionManifest;
  readonly projectManifest: {
    readonly path: string;
    readonly manifest: ProjectManifest;
  };
  readonly sessionPath: string;
}

/** Create (or reopen) the root-session manifest and ensure the project manifest exists. */
export function startRootSession(input: StartRootSessionInput): StartRootSessionResult {
  const projectRoot = canonicalProjectRoot(input.projectRoot);
  const projectManifest = writeProjectManifest(projectRoot, input.now);
  const now = input.now ?? new Date().toISOString();
  const sessionId = input.sessionId;
  const sessionPath = homeSessionManifestFile(encodeProjectId(projectRoot), sessionId);
  const existing = existsSync(sessionPath) ? readPrivateJson<SessionManifest>(sessionPath) : undefined;
  const manifest: SessionManifest = {
    sessionId,
    sessionFile: input.sessionFile ?? existing?.sessionFile,
    active: true,
    canonicalRoot: projectRoot,
    pid: input.pid ?? existing?.pid,
    processStartTime: input.processStartTime ?? existing?.processStartTime,
    startedAt: existing?.startedAt ?? now,
    lastSeenAt: now,
  };
  writePrivateJson(sessionPath, manifest);
  return { manifest, projectManifest, sessionPath };
}

export interface FinishRootSessionInput {
  projectRoot: string;
  sessionId: string;
  reason?: string;
  now?: string;
}

export interface FinishRootSessionResult {
  readonly active: boolean;
  readonly endedAt: string;
  readonly manifest: SessionManifest;
}

/** Flip the root-session manifest inactive atomically. */
export function finishRootSession(input: FinishRootSessionInput): FinishRootSessionResult {
  const projectRoot = canonicalProjectRoot(input.projectRoot);
  const now = input.now ?? new Date().toISOString();
  const sessionPath = homeSessionManifestFile(encodeProjectId(projectRoot), input.sessionId);
  const manifest: SessionManifest = {
    ...readSessionManifest(projectRoot, input.sessionId),
    active: false,
    endedAt: now,
    lastSeenAt: now,
  };
  writePrivateJson(sessionPath, manifest);
  return { active: false, endedAt: now, manifest };
}

/** Read the root-session manifest, failing closed on corruption. */
export function readSessionManifest(projectRoot: string, sessionId: string): SessionManifest {
  const path = homeSessionManifestFile(encodeProjectId(projectRoot), sessionId);
  return readPrivateJson<SessionManifest>(path);
}

/** A single append-only agent lifecycle event. */
export type AgentLifecycleEvent =
  | {
      readonly type: "agent_created";
      readonly at: string;
      readonly agentId: string;
      readonly piSessionId: string;
      readonly rootSessionId: string;
      readonly parentAgentIds: readonly string[];
      readonly rootAgentId: string;
      readonly depth: number;
      readonly status: "created";
      readonly description: string;
      readonly subagentType: string;
    }
  | {
      readonly type: "agent_updated";
      readonly at: string;
      readonly agentId: string;
      readonly status: JobStatus;
      readonly startedAt?: string;
      readonly endedAt?: string;
      readonly delivered?: boolean;
      readonly sessionFile?: string;
    };

/** The materialized snapshot reproduced by folding agent events. */
export interface AgentManifest {
  readonly agentId: string;
  readonly piSessionId: string;
  readonly rootSessionId: string;
  readonly parentAgentIds: readonly string[];
  readonly rootAgentId: string;
  readonly depth: number;
  status: JobStatus;
  readonly description: string;
  readonly subagentType: string;
  startedAt?: string;
  endedAt?: string;
  delivered: boolean;
  readonly createdAt: string;
  updatedAt: string;
  sessionFile?: string;
}

function parseAgentEvent(line: string): AgentLifecycleEvent | null {
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as AgentLifecycleEvent;
    if (parsed && typeof parsed.type === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

function eventAt(event: AgentLifecycleEvent): string {
  return event.at;
}

/** Fold an agent event log into the current snapshot state. */
export function foldAgentEvents(filePath: string): AgentManifest | undefined {
  if (!existsSync(filePath)) return undefined;
  let snapshot: AgentManifest | undefined;
  const reads: Array<{ at: string; event: AgentLifecycleEvent }> = [];
  for (const line of readFileSync(filePath, "utf-8").split("\n")) {
    const event = parseAgentEvent(line);
    if (!event) continue;
    reads.push({ at: eventAt(event), event });
  }
  reads.sort((a, b) => a.at.localeCompare(b.at));
  for (const { event } of reads) {
    if (event.type === "agent_created") {
      snapshot = {
        agentId: event.agentId,
        piSessionId: event.piSessionId,
        rootSessionId: event.rootSessionId,
        parentAgentIds: [...event.parentAgentIds],
        rootAgentId: event.rootAgentId,
        depth: event.depth,
        status: event.status,
        description: event.description,
        subagentType: event.subagentType,
        delivered: false,
        createdAt: event.at,
        updatedAt: event.at,
      };
    } else if (snapshot) {
      snapshot = {
        ...snapshot,
        status: event.status,
        startedAt: event.startedAt ?? snapshot.startedAt,
        endedAt: event.endedAt ?? snapshot.endedAt,
        delivered: event.delivered ?? snapshot.delivered,
        sessionFile: event.sessionFile ?? snapshot.sessionFile,
        updatedAt: event.at,
      };
    }
  }
  return snapshot;
}

function canonicalAgentIdFromJobId(jobId: string): string {
  return canonicalAgentId(jobId);
}

export interface CreateAgentManifestStoreInput {
  projectRoot: string;
  rootSessionId: string;
  jobId: string;
  piSessionId?: string;
  parentAgentIds?: readonly string[];
  rootAgentId?: string;
  depth?: number;
  now?: string;
}

export interface AgentManifestStore {
  readonly agentId: string;
  readonly agentDir: string;
  readonly manifestPath: string;
  readonly eventsPath: string;
  readonly projectId: string;
  create(input: { status?: "created"; description: string; subagentType: string }): void;
  update(input: { status: JobStatus; at?: string; startedAt?: string; endedAt?: string; delivered?: boolean; sessionFile?: string }): void;
  read(): AgentManifest | undefined;
}

/** Agent manifest store writing append-only events and a materialized snapshot. */
export function createAgentManifestStore(input: CreateAgentManifestStoreInput): AgentManifestStore {
  const projectRoot = canonicalProjectRoot(input.projectRoot);
  const projectId = encodeProjectId(projectRoot);
  const agentId = canonicalAgentIdFromJobId(input.jobId);
  const rootSessionId = input.rootSessionId;
  const parentAgentIds = (input.parentAgentIds ?? []).map(canonicalAgentIdFromJobId);
  const rootAgentId = input.rootAgentId ? canonicalAgentIdFromJobId(input.rootAgentId) : agentId;
  const depth = input.depth ?? (parentAgentIds.length === 0 ? 0 : parentAgentIds.length + 1);
  const piSessionId = input.piSessionId ?? canonicalAgentId(input.jobId);
  const eventsPath = homeAgentEventsFile(projectId, rootSessionId, agentId, parentAgentIds);
  const manifestPath = homeAgentManifestFile(projectId, rootSessionId, agentId, parentAgentIds);
  const agentDir = homeAgentDir(projectId, rootSessionId, agentId, parentAgentIds);

  const append = (line: object): void => {
    ensurePrivateDirectory(agentDir);
    const serialized = `${JSON.stringify(line)}\n`;
    if (!existsSync(eventsPath)) {
      // First write is atomic and owner-only; content is single-line JSONL.
      writePrivateText(eventsPath, serialized);
      return;
    }
    // JSONL is append-only. Existing files are already private; the append
    // mode keeps the file owner-only and repairs a reopened permissive file.
    appendFileSync(eventsPath, serialized, { encoding: "utf8", mode: 0o600 });
    chmodSync(eventsPath, 0o600);
  };

  const store: AgentManifestStore = {
    agentId,
    agentDir,
    manifestPath,
    eventsPath,
    projectId,
    create({ description, subagentType }): void {
      const existing = foldAgentEvents(eventsPath);
      if (existing) {
        if (!existsSync(manifestPath)) writePrivateJson(manifestPath, existing);
        return;
      }
      const created: AgentLifecycleEvent = {
        type: "agent_created",
        at: input.now ?? new Date().toISOString(),
        agentId,
        piSessionId,
        rootSessionId,
        parentAgentIds,
        rootAgentId,
        depth,
        status: "created",
        description,
        subagentType,
      };
      append(created);
      const snapshot = foldAgentEvents(eventsPath);
      if (snapshot) writePrivateJson(manifestPath, snapshot);
    },
    update(cfg): void {
      const updated: AgentLifecycleEvent = {
        type: "agent_updated",
        at: cfg.at ?? new Date().toISOString(),
        agentId,
        status: cfg.status,
        startedAt: cfg.startedAt,
        endedAt: cfg.endedAt,
        delivered: cfg.delivered,
        sessionFile: cfg.sessionFile,
      };
      append(updated);
      const snapshot = foldAgentEvents(eventsPath);
      if (snapshot) writePrivateJson(manifestPath, snapshot);
    },
    read(): AgentManifest | undefined {
      return foldAgentEvents(eventsPath);
    },
  };
  return store;
}

/** Read one agent snapshot directly, failing closed on a corrupt manifest. */
export function readAgentManifest(projectRoot: string, rootSessionId: string, jobId: string, parentAgentIds?: readonly string[]): AgentManifest {
  const projectId = encodeProjectId(projectRoot);
  const agentId = canonicalAgentIdFromJobId(jobId);
  const path = homeAgentManifestFile(projectId, rootSessionId, agentId, (parentAgentIds ?? []).map(canonicalAgentIdFromJobId));
  return readPrivateJson<AgentManifest>(path);
}
