import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Home-scoped pi-code storage names. */
export const RUNTIME_DIR_NAME = "pi-code";
export const PROJECTS_DIR_NAME = "projects";
export const SESSIONS_DIR_NAME = "sessions";
export const AGENTS_DIR_NAME = "agents";
export const PROJECT_MANIFEST_FILE_NAME = "project.json";
export const SESSION_MANIFEST_FILE_NAME = "session.json";
export const AGENT_MANIFEST_FILE_NAME = "agent.json";
export const GOALS_FILE_NAME = "goals.jsonl";
export const EVENTS_FILE_NAME = "events.jsonl";
export const ERRORS_FILE_NAME = "errors.jsonl";
export const TRANSCRIPT_FILE_NAME = "transcript.jsonl";
export const SCOPED_REGISTRY_PREFIX = "jobs-";
export const SCOPED_REGISTRY_SUFFIX = ".jsonl";

const SAFE_PROJECT_ID_BYTE = (byte: number): boolean =>
  (byte >= 0x41 && byte <= 0x5a) ||
  (byte >= 0x61 && byte <= 0x7a) ||
  (byte >= 0x30 && byte <= 0x39) ||
  byte === 0x2e ||
  byte === 0x5f;
const HEX = "0123456789ABCDEF";
const PROJECT_ID_DELIMITER = "--";
const IS_WIN = process.platform === "win32";
const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const DATE_ID = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Resolve symlinks and relative segments before deriving project storage identity. */
export function canonicalProjectRoot(input: string): string {
  const absolute = isAbsolute(input) ? input : resolve(process.cwd(), input);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function encodeComponent(component: string): string {
  const bytes = Buffer.from(component, "utf8");
  let encoded = "";
  for (const byte of bytes) {
    if (SAFE_PROJECT_ID_BYTE(byte)) encoded += String.fromCharCode(byte);
    else encoded += `%${HEX[byte >> 4]}${HEX[byte & 0x0f]}`;
  }
  return encoded;
}

function decodeComponent(component: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < component.length;) {
    const character = component[index];
    if (character !== "%") {
      if (!/[A-Za-z0-9._]/.test(character)) throw new Error(`Invalid project id component: ${component}`);
      bytes.push(character.charCodeAt(0));
      index += 1;
      continue;
    }
    if (index + 2 >= component.length || !/^[0-9A-Fa-f]{2}$/.test(component.slice(index + 1, index + 3))) {
      throw new Error(`Invalid project id escape: ${component}`);
    }
    bytes.push(Number.parseInt(component.slice(index + 1, index + 3), 16));
    index += 3;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
}

/**
 * Split a canonical absolute root into path components. On POSIX only `/` is a
 * separator, so a literal backslash stays inside a component (and is later
 * percent-encoded). On Windows both separators act as component boundaries.
 */
function splitRootComponents(root: string): string[] {
  return IS_WIN ? root.split(/[\\/]/) : root.split("/");
}

/** Reconstruct a path from decoded components using the platform separator. */
function joinRootComponents(components: string[]): string {
  return IS_WIN ? components.join("\\") : components.join("/");
}

/**
 * Encode a canonical absolute root as one safe, reversible directory segment.
 * Components are joined by `--`; every hyphen and special character is encoded,
 * so the delimiter is never ambiguous with a literal path component.
 */
export function encodeProjectId(projectRoot: string): string {
  const canonical = canonicalProjectRoot(projectRoot);
  if (!isAbsolute(canonical)) throw new Error(`Project root must be absolute: ${projectRoot}`);
  return splitRootComponents(canonical).map(encodeComponent).join(PROJECT_ID_DELIMITER);
}

/** Decode a project ID produced by encodeProjectId. */
export function decodeProjectId(projectId: string): string {
  const components = projectId.split(PROJECT_ID_DELIMITER).map(decodeComponent);
  if (!IS_WIN && components[0] !== "") throw new Error(`Project id must represent an absolute path: ${projectId}`);
  const decoded = joinRootComponents(components);
  if (!isAbsolute(decoded)) throw new Error(`Project id is not absolute: ${projectId}`);
  return decoded;
}

/** The agent's home directory, respecting the Pi agent directory override with tilde expansion. */
export function homeAgentDirectory(): string {
  // getAgentDir() already expands a `PI_CODING_AGENT_DIR` tilde and defaults to
  // `~/.pi/agent`; resolve it absolute so storage never depends on cwd.
  return resolve(getAgentDir());
}

/** Expand a leading `~` and resolve a configured storage base. */
function resolveHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return resolve(value);
}

/** The configured pi-code home base, or the Pi agent home directory default. */
export function homeRootBase(): string {
  const configured = process.env.XZY_PI_CODE_HOME;
  const base = configured && configured.length > 0 ? resolveHome(configured) : homeAgentDirectory();
  return canonicalProjectRoot(base);
}

export function homeRoot(): string {
  return join(homeRootBase(), RUNTIME_DIR_NAME);
}

export function homeProjectsDir(): string {
  return join(homeRoot(), PROJECTS_DIR_NAME);
}

function validateId(id: string, label: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`Invalid ${label}: ${id}`);
  return id;
}

function projectIdPath(projectId: string): string {
  if (!projectId || projectId.includes("/") || projectId.includes("\\")) throw new Error(`Invalid project id: ${projectId}`);
  // Validate the encoding, including delimiter and percent escapes, without
  // requiring callers to decode the path just to construct a path.
  decodeProjectId(projectId);
  return projectId;
}

export function homeProjectDir(projectId: string): string {
  return join(homeProjectsDir(), projectIdPath(projectId));
}

export function homeProjectDirFromRoot(projectRoot: string): string {
  return homeProjectDir(encodeProjectId(projectRoot));
}

export function homeProjectManifestFile(projectId: string): string {
  return join(homeProjectDir(projectId), PROJECT_MANIFEST_FILE_NAME);
}

export function homeSessionDir(projectId: string, rootSessionId: string): string {
  return join(homeProjectDir(projectId), SESSIONS_DIR_NAME, validateId(rootSessionId, "session id"));
}

export function homeSessionDirFromRoot(projectRoot: string, rootSessionId: string): string {
  return homeSessionDir(encodeProjectId(projectRoot), rootSessionId);
}

export function homeSessionManifestFile(projectId: string, rootSessionId: string): string {
  return join(homeSessionDir(projectId, rootSessionId), SESSION_MANIFEST_FILE_NAME);
}

export function homeAgentDir(
  projectId: string,
  rootSessionId: string,
  agentId: string,
  parentAgentIds: readonly string[] = [],
): string {
  const parentIds = parentAgentIds.map((id) => validateId(id, "parent agent id"));
  const nestedPath: string[] = [AGENTS_DIR_NAME];
  for (const parentId of parentIds) nestedPath.push(parentId, AGENTS_DIR_NAME);
  nestedPath.push(validateId(agentId, "agent id"));
  return join(homeSessionDir(projectId, rootSessionId), ...nestedPath);
}

export function homeAgentManifestFile(projectId: string, rootSessionId: string, agentId: string, parentAgentIds?: readonly string[]): string {
  return join(homeAgentDir(projectId, rootSessionId, agentId, parentAgentIds), AGENT_MANIFEST_FILE_NAME);
}

export function homeAgentEventsFile(projectId: string, rootSessionId: string, agentId: string, parentAgentIds?: readonly string[]): string {
  return join(homeAgentDir(projectId, rootSessionId, agentId, parentAgentIds), EVENTS_FILE_NAME);
}

export function homeAgentErrorsFile(projectId: string, rootSessionId: string, agentId: string, parentAgentIds?: readonly string[]): string {
  return join(homeAgentDir(projectId, rootSessionId, agentId, parentAgentIds), ERRORS_FILE_NAME);
}

export function homeAgentTranscriptFile(projectId: string, rootSessionId: string, agentId: string, parentAgentIds?: readonly string[]): string {
  return join(homeAgentDir(projectId, rootSessionId, agentId, parentAgentIds), TRANSCRIPT_FILE_NAME);
}

export function homeGoalFile(projectId: string, rootSessionId: string): string {
  return join(homeSessionDir(projectId, rootSessionId), GOALS_FILE_NAME);
}

function dailyDir(projectId: string, rootSessionId: string, localDate: string): string {
  const match = DATE_ID.exec(localDate);
  if (!match) throw new Error(`Invalid local date: ${localDate}`);
  return join(homeSessionDir(projectId, rootSessionId), "logs", match[1]!, match[2]!, match[3]!);
}

export function homeDailyEventFile(projectId: string, rootSessionId: string, localDate: string): string {
  return join(dailyDir(projectId, rootSessionId, localDate), EVENTS_FILE_NAME);
}

export function homeDailyErrorFile(projectId: string, rootSessionId: string, localDate: string): string {
  return join(dailyDir(projectId, rootSessionId, localDate), ERRORS_FILE_NAME);
}

export function homeChannelConfigFile(projectId: string): string {
  return join(homeProjectDir(projectId), "channel.json");
}

export function homeChannelRuntimeFile(projectId: string): string {
  return join(homeProjectDir(projectId), "channel.runtime.json");
}

export function homeChannelOwnerFile(projectId: string): string {
  return join(homeProjectDir(projectId), "channel.owner.json");
}

/** Ensure one private directory exists, repairing home-storage ancestors. */
export function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // realpath keeps macOS `/var` and `/private/var` aliases comparable and
  // chmods the same inode that callers observe through either spelling.
  const absolute = realpathSync(resolve(directory));
  const homeBoundary = realpathSync(resolve(homeRootBase()));
  const boundaryRelative = relative(homeBoundary, absolute);
  const isHomePath = boundaryRelative === "" || !boundaryRelative.startsWith(`..${sep}`);
  const boundary = isHomePath ? homeBoundary : absolute;
  // Repair every home-storage component, including pre-existing permissive
  // bases, but never chmod unrelated parents such as /tmp or the filesystem root.
  for (let current = absolute; ; ) {
    chmodSync(current, 0o700);
    if (current === boundary) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Atomically write JSON with owner-only permissions. */
export function writePrivateJson(filePath: string, value: unknown): void {
  const directory = dirname(filePath);
  ensurePrivateDirectory(directory);
  const base = filePath.split(/[\\/]/).pop()!;
  const temporaryPath = join(directory, `.${base}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
}

/** Read a private JSON manifest without repairing or replacing corrupt state. */
export function readPrivateJson<T>(filePath: string): T {
  const raw = readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`Corrupt JSON manifest: ${filePath}`, { cause: error });
  }
}

// Legacy project-local path aliases retained until their consumers migrate in
// later phases. The registry/goal/session consumers still read project-local
// state during Phase 1; only the new home helpers are used by new callers.
export function runtimeDir(projectRoot: string): string {
  return join(projectRoot, ".pi", RUNTIME_DIR_NAME);
}

export function goalsFile(projectRoot: string): string {
  return join(runtimeDir(projectRoot), GOALS_FILE_NAME);
}

export function scopedSessionsDir(projectRoot: string): string {
  return join(runtimeDir(projectRoot), SESSIONS_DIR_NAME);
}

function validateSessionId(sessionId: string): string {
  return validateId(sessionId, "session id");
}

export function sessionDir(projectRoot: string, sessionId: string): string {
  return join(scopedSessionsDir(projectRoot), validateSessionId(sessionId));
}

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

export function scopedRegistryFile(projectRoot: string, parentSessionId: string): string {
  return sessionRegistryFile(projectRoot, parentSessionId);
}

export function childTranscriptDir(projectRoot: string, parentSessionId: string): string {
  return childSessionDir(projectRoot, parentSessionId);
}

export function childTranscriptFile(projectRoot: string, parentSessionId: string, jobId: string): string {
  return join(childTranscriptDir(projectRoot, parentSessionId), `${validateId(jobId, "job id")}.jsonl`);
}

export { validateSessionId as assertSessionId };
