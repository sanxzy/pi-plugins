import { appendFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { canTransition, type JobStatus } from "@xzy-ai/core";
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
import { writePonytailState } from "../ponytail/state.ts";
import { resolveSettingsForProject } from "../../shared/settings.ts";
import { PERSISTENCE_OPERATIONS, processWithLog } from "@xzy-ai/observability";

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
  return processWithLog({ operation: PERSISTENCE_OPERATIONS.MANIFEST_PROJECT_WRITE, parameters: { projectRoot } }, () => {
  const canonicalRoot = canonicalProjectRoot(projectRoot);
  const projectId = encodeProjectId(canonicalRoot);
  const path = homeProjectManifestFile(projectId);
  const existing = existsSync(path) ? readProjectManifestFromPath(path) : undefined;
  if (existing && existing.canonicalRoot !== canonicalRoot) {
    throw new Error(`Project manifest root mismatch: ${path}`);
  }
  const manifest: ProjectManifest = {
    canonicalRoot,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  writePrivateJson(path, manifest);
  return { path, manifest };
  });
}

/** Read the project manifest for a project root, failing closed on corruption. */
export function readProjectManifest(projectRoot: string): ProjectManifest {
  const canonicalRoot = canonicalProjectRoot(projectRoot);
  const path = homeProjectManifestFile(encodeProjectId(canonicalRoot));
  const manifest = readProjectManifestFromPath(path);
  if (manifest.canonicalRoot !== canonicalRoot) {
    throw new Error(`Project manifest root mismatch: ${path}`);
  }
  return manifest;
}

function readProjectManifestFromPath(path: string): ProjectManifest {
  return validateProjectManifest(readPrivateJson<Partial<ProjectManifest>>(path), path);
}

/** Validate a project manifest, failing closed on structural or root mismatch. */
function validateProjectManifest(raw: Partial<ProjectManifest>, path: string): ProjectManifest {
  if (
    typeof raw.canonicalRoot !== "string" ||
    typeof raw.createdAt !== "string" ||
    typeof raw.updatedAt !== "string"
  ) {
    throw new Error(`Invalid project manifest: ${path}`);
  }
  return raw as ProjectManifest;
}

/** Validate a session manifest, failing closed on structural corruption. */
function validateSessionManifest(raw: Partial<SessionManifest>, path: string): SessionManifest {
  if (
    typeof raw.sessionId !== "string" ||
    typeof raw.active !== "boolean" ||
    typeof raw.canonicalRoot !== "string" ||
    typeof raw.startedAt !== "string" ||
    typeof raw.lastSeenAt !== "string"
  ) {
    throw new Error(`Invalid session manifest: ${path}`);
  }
  return raw as SessionManifest;
}

/** Validate an agent manifest, failing closed on structural corruption. */
function validateAgentManifest(raw: Partial<AgentManifest>, path: string): AgentManifest {
  if (
    typeof raw.jobId !== "string" ||
    typeof raw.agentId !== "string" ||
    typeof raw.piSessionId !== "string" ||
    typeof raw.rootSessionId !== "string" ||
    (raw.parentJobId !== undefined && typeof raw.parentJobId !== "string") ||
    (raw.parentSessionId !== undefined && typeof raw.parentSessionId !== "string") ||
    typeof raw.depth !== "number" ||
    typeof raw.description !== "string" ||
    typeof raw.subagentType !== "string" ||
    typeof raw.status !== "string" ||
    typeof raw.delivered !== "boolean" ||
    typeof raw.createdAt !== "string" ||
    typeof raw.updatedAt !== "string" ||
    !Array.isArray(raw.parentAgentIds)
  ) {
    throw new Error(`Invalid agent manifest: ${path}`);
  }
  return raw as AgentManifest;
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

/**
 * Initialize Ponytail state only for new root sessions whose home policy is
 * enabled. Existing sessions keep their explicit state authoritative; disabled
 * roots receive no state until they opt in. Corrupt state is recovered lazily
 * on the next read and never blocks lifecycle start.
 */
function initializePonytailState(sessionId: string, projectRoot: string, isExisting: boolean): void {
  if (isExisting) return;
  const homeEnabled = resolveSettingsForProject(projectRoot).tools.ponytailEnabled;
  if (!homeEnabled) return;
  try {
    writePonytailState(sessionId, { version: 1, enabled: true, tickets: [] });
  } catch {
    // Non-fatal: lifecycle must not fail because private state cannot be written.
  }
}

/** Create (or reopen) the root-session manifest and ensure the project manifest exists. */
export function startRootSession(input: StartRootSessionInput): StartRootSessionResult {
  return processWithLog({ operation: PERSISTENCE_OPERATIONS.MANIFEST_START, parameters: { sessionId: input.sessionId, projectRoot: input.projectRoot } }, () => {
  const projectRoot = canonicalProjectRoot(input.projectRoot);
  const projectManifest = writeProjectManifest(projectRoot, input.now);
  const now = input.now ?? new Date().toISOString();
  const sessionId = input.sessionId;
  const sessionPath = homeSessionManifestFile(encodeProjectId(projectRoot), sessionId);
  const existing = existsSync(sessionPath)
    ? validateSessionManifest(readPrivateJson<Partial<SessionManifest>>(sessionPath), sessionPath)
    : undefined;
  if (existing && existing.canonicalRoot !== projectRoot) {
    throw new Error(`Session manifest root mismatch: ${sessionPath}`);
  }
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
  initializePonytailState(input.sessionId, projectRoot, existing !== undefined);
  return { manifest, projectManifest, sessionPath };
  });
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
  return processWithLog({ operation: PERSISTENCE_OPERATIONS.MANIFEST_FINISH, parameters: { sessionId: input.sessionId, reason: input.reason } }, () => {
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
  });
}

/** Read the root-session manifest, failing closed on corruption. */
export function readSessionManifest(projectRoot: string, sessionId: string): SessionManifest {
  const path = homeSessionManifestFile(encodeProjectId(projectRoot), sessionId);
  const manifest = validateSessionManifest(readPrivateJson<Partial<SessionManifest>>(path), path);
  if (manifest.canonicalRoot !== canonicalProjectRoot(projectRoot)) {
    throw new Error(`Session manifest root mismatch: ${path}`);
  }
  if (manifest.sessionId !== sessionId) {
    throw new Error(`Session manifest id mismatch: ${path}`);
  }
  return manifest;
}

/** A single append-only agent lifecycle event. */
export type AgentLifecycleEvent =
  | {
      readonly type: "agent_created";
      readonly at: string;
      readonly jobId: string;
      readonly sequence?: number;
      readonly agentId: string;
      readonly piSessionId: string;
      readonly rootSessionId: string;
      readonly parentAgentIds: readonly string[];
      readonly parentJobId?: string;
      readonly parentSessionId?: string;
      readonly rootAgentId: string;
      readonly depth: number;
      readonly status: "created";
      readonly description: string;
      readonly subagentType: string;
      readonly sessionFile?: string;
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
  readonly jobId: string;
  readonly sequence?: number;
  readonly agentId: string;
  readonly piSessionId: string;
  readonly rootSessionId: string;
  readonly parentAgentIds: readonly string[];
  readonly parentJobId?: string;
  readonly parentSessionId?: string;
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

const JOB_STATUSES = new Set<JobStatus>(["created", "queued", "running", "completed", "failed", "cancelled", "interrupted"]);

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function optionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function optionalSequence(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function parseAgentEvent(line: string): AgentLifecycleEvent | null {
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (!parsed || typeof parsed.type !== "string") return null;
    if (parsed.type === "agent_created") {
      if (
        typeof parsed.at !== "string" ||
        typeof parsed.jobId !== "string" ||
        typeof parsed.agentId !== "string" ||
        typeof parsed.piSessionId !== "string" ||
        typeof parsed.rootSessionId !== "string" ||
        !Array.isArray(parsed.parentAgentIds) ||
        !parsed.parentAgentIds.every((id): id is string => typeof id === "string") ||
        !optionalString(parsed.parentJobId) ||
        !optionalString(parsed.parentSessionId) ||
        !optionalString(parsed.sessionFile) ||
        !optionalSequence(parsed.sequence) ||
        typeof parsed.rootAgentId !== "string" ||
        typeof parsed.depth !== "number" ||
        !Number.isSafeInteger(parsed.depth) ||
        parsed.depth < 0 ||
        parsed.status !== "created" ||
        typeof parsed.description !== "string" ||
        typeof parsed.subagentType !== "string"
      ) {
        return null;
      }
      return parsed as unknown as AgentLifecycleEvent;
    }
    if (parsed.type === "agent_updated") {
      if (
        typeof parsed.at !== "string" ||
        typeof parsed.agentId !== "string" ||
        typeof parsed.status !== "string" ||
        !JOB_STATUSES.has(parsed.status as JobStatus) ||
        !optionalString(parsed.startedAt) ||
        !optionalString(parsed.endedAt) ||
        !optionalString(parsed.sessionFile) ||
        !optionalBoolean(parsed.delivered)
      ) return null;
      return parsed as unknown as AgentLifecycleEvent;
    }
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
        jobId: event.jobId,
        sequence: event.sequence,
        agentId: event.agentId,
        piSessionId: event.piSessionId,
        rootSessionId: event.rootSessionId,
        parentAgentIds: [...event.parentAgentIds],
        parentJobId: event.parentJobId,
        parentSessionId: event.parentSessionId,
        rootAgentId: event.rootAgentId,
        depth: event.depth,
        status: event.status,
        description: event.description,
        subagentType: event.subagentType,
        delivered: false,
        sessionFile: event.sessionFile,
        createdAt: event.at,
        updatedAt: event.at,
      };
    } else if (snapshot && event.agentId === snapshot.agentId && (event.status === snapshot.status || canTransition(snapshot.status, event.status))) {
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

/** Compare two agent snapshots for equality across all materialized fields. */
function agentSnapshotsEqual(a: AgentManifest, b: AgentManifest): boolean {
  return (
    a.jobId === b.jobId &&
    a.agentId === b.agentId &&
    a.piSessionId === b.piSessionId &&
    a.rootSessionId === b.rootSessionId &&
    a.parentJobId === b.parentJobId &&
    a.parentSessionId === b.parentSessionId &&
    a.rootAgentId === b.rootAgentId &&
    a.depth === b.depth &&
    a.status === b.status &&
    a.description === b.description &&
    a.subagentType === b.subagentType &&
    a.delivered === b.delivered &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    a.startedAt === b.startedAt &&
    a.endedAt === b.endedAt &&
    a.sessionFile === b.sessionFile &&
    a.sequence === b.sequence &&
    a.parentAgentIds.length === b.parentAgentIds.length &&
    a.parentAgentIds.every((id, index) => id === b.parentAgentIds[index])
  );
}

export interface CreateAgentManifestStoreInput {
  projectRoot: string;
  rootSessionId: string;
  jobId: string;
  piSessionId?: string;
  parentAgentIds?: readonly string[];
  parentJobId?: string;
  parentSessionId?: string;
  rootAgentId?: string;
  depth?: number;
  sessionFile?: string;
  sequence?: number;
  now?: string;
}

export interface AgentManifestStore {
  readonly agentId: string;
  readonly jobId: string;
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
  const jobId = canonicalAgentIdFromJobId(input.jobId);
  const rootSessionId = input.rootSessionId;
  const piSessionId = input.piSessionId ?? agentId;
  const parentAgentIds = (input.parentAgentIds ?? []).map(canonicalAgentIdFromJobId);
  const rootAgentId = input.rootAgentId ? canonicalAgentIdFromJobId(input.rootAgentId) : agentId;
  const depth = input.depth ?? (parentAgentIds.length === 0 ? 0 : parentAgentIds.length + 1);
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
    jobId,
    agentDir,
    manifestPath,
    eventsPath,
    projectId,
    create({ description, subagentType }): void {
      processWithLog({ operation: PERSISTENCE_OPERATIONS.MANIFEST_AGENT_CREATE, parameters: { agentId } }, () => {
      if (existsSync(manifestPath)) {
        const existingManifest = validateAgentManifest(readPrivateJson<Partial<AgentManifest>>(manifestPath), manifestPath);
        if (existingManifest.agentId !== agentId || existingManifest.rootSessionId !== rootSessionId) {
          throw new Error(`Agent manifest identity mismatch: ${manifestPath}`);
        }
      }
      const existing = foldAgentEvents(eventsPath);
      if (existing) {
        if (!existsSync(manifestPath) || !readAgentSnapshotValid(manifestPath, existing)) writePrivateJson(manifestPath, existing);
        return;
      }
      const created: AgentLifecycleEvent = {
        type: "agent_created",
        at: input.now ?? new Date().toISOString(),
        jobId,
        sequence: input.sequence,
        agentId,
        piSessionId,
        rootSessionId,
        parentAgentIds,
        parentJobId: input.parentJobId,
        parentSessionId: input.parentSessionId,
        rootAgentId,
        depth,
        status: "created",
        description,
        subagentType,
        sessionFile: input.sessionFile,
      };
      append(created);
      const snapshot = foldAgentEvents(eventsPath);
      if (snapshot) writePrivateJson(manifestPath, snapshot);
      });
    },
    update(cfg): void {
      processWithLog({ operation: PERSISTENCE_OPERATIONS.MANIFEST_AGENT_UPDATE, parameters: { agentId, status: cfg.status } }, () => {
      const current = foldAgentEvents(eventsPath);
      if (!current) return;
      if (cfg.status !== current.status && !canTransition(current.status, cfg.status)) return;
      const updated: AgentLifecycleEvent = {
        type: "agent_updated",
        at: cfg.at ?? new Date().toISOString(),
        agentId,
        status: cfg.status,
        startedAt: cfg.startedAt,
        endedAt: cfg.endedAt,
        delivered: cfg.delivered,
        sessionFile: cfg.sessionFile ?? current.sessionFile,
      };
      append(updated);
      rebuildSnapshot(eventsPath, manifestPath);
      });
    },
    read(): AgentManifest | undefined {
      const folded = foldAgentEvents(eventsPath);
      if (folded && (!existsSync(manifestPath) || !readAgentSnapshotValid(manifestPath, folded))) rebuildSnapshot(eventsPath, manifestPath);
      return folded;
    },
  };
  return store;
}

/** Rebuild the private agent.json snapshot from the authoritative event log. */
function rebuildSnapshot(eventsPath: string, manifestPath: string): void {
  const snapshot = foldAgentEvents(eventsPath);
  if (snapshot) writePrivateJson(manifestPath, snapshot);
}

/** A snapshot is usable only when it is structurally valid and matches the fold. */
function readAgentSnapshotValid(manifestPath: string, folded: AgentManifest): boolean {
  if (!existsSync(manifestPath)) return false;
  try {
    const snapshot = validateAgentManifest(readPrivateJson<Partial<AgentManifest>>(manifestPath), manifestPath);
    return agentSnapshotsEqual(snapshot, folded);
  } catch {
    return false;
  }
}

/** Read one agent snapshot directly, failing closed on a corrupt manifest. */
export function readAgentManifest(projectRoot: string, rootSessionId: string, jobId: string, parentAgentIds?: readonly string[]): AgentManifest {
  const projectId = encodeProjectId(projectRoot);
  const agentId = canonicalAgentIdFromJobId(jobId);
  const path = homeAgentManifestFile(projectId, rootSessionId, agentId, (parentAgentIds ?? []).map(canonicalAgentIdFromJobId));
  const manifest = validateAgentManifest(readPrivateJson<Partial<AgentManifest>>(path), path);
  if (manifest.agentId !== agentId || manifest.rootSessionId !== rootSessionId) {
    throw new Error(`Agent manifest identity mismatch: ${path}`);
  }
  return manifest;
}
