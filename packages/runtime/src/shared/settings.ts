import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_MAX_AGENT_DEPTH, MAX_CONCURRENCY, MAX_PARALLEL_AGENTS } from "@xzy-ai/core";
import { homeRoot } from "./paths.ts";

/**
 * Centralized pi-c2 settings.
 *
 * A validated, plain-JSON settings file located at `homeRoot()/config.json`.
 * Resolution is lazy behind a file fingerprint that observes creation, edits
 * (including equal-size rewrites), and removal; recognized fields are validated
 * independently so an invalid higher-precedence value falls back to a lower-
 * precedence value rather than erasing unrelated fields.
 *
 * Precedence per field: existing environment alias > project `.pi/pi-c2.json` >
 * home `homeRoot()/config.json` > build-time default. `mcp.json` and
 * `references.json` remain separate loaders and are never parsed here.
 */

export interface AgentSettings {
  maxAgentDepth: number;
  maxConcurrency: number;
  maxParallelAgents: number;
  retainedTerminalJobs: number;
  retainedTerminalAgents: number;
}

export interface RuntimeSettings {
  deliveryRetryDelayMs: number;
  gitTimeoutMs: number;
  gitLockStaleMs: number;
  gitLockAcquireTimeoutMs: number;
  gitMaxBufferBytes: number;
}

export interface ChannelSettings {
  maxRootSessions: number;
  lockStaleMs: number;
  lockUpdateMs: number;
  lockAcquireRetries: number;
  maxTextLength: number;
  pairingPendingTtlMs: number;
  pairingPendingMax: number;
  mediaPhotoMaxBytes: number;
  mediaDocumentMaxBytes: number;
  mediaTimeoutMs: number;
}

export interface WebSettings {
  searchTimeoutMs: number;
  fetchTimeoutSeconds: number;
  maxResponseBytes: number;
  defaultNumResults: number;
  defaultSearchType: "auto" | "fast" | "deep";
  defaultLivecrawl: "fallback" | "preferred";
  exaApiKey?: string;
}

export interface McpSettings {
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  reconnectMaxAttempts: number;
  reconnectBaseDelayMs: number;
  resultMaxText: number;
  resultMaxAttachmentBytes: number;
  oauthCallbackTimeoutMs: number;
}

export interface CommandSettings {
  telegram: { reactionTimeoutMs: number };
  goalMaxPromptLength: number;
}

export interface ResolvedSettings {
  agents: AgentSettings;
  runtime: RuntimeSettings;
  channels: ChannelSettings;
  tools: { web: WebSettings };
  mcp: McpSettings;
  commands: CommandSettings;
}

const PROJECT_CONFIG_RELATIVE = join(".pi", "pi-c2.json");

/** Default number of results from Exa, clamped to its hard non-configurable maximum. */
export const DEFAULT_WEB_RESULTS = 5;
export const MAX_WEB_RESULTS = 20;

/** The canonical centralized settings file under the pi-c2 runtime home. */
export function settingsConfigPath(): string {
  return join(homeRoot(), "config.json");
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUint = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
const isPosInt = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;
const isMs = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MIB = 1024 * 1024;

/** Public safety bounds for a bounded set of selected settings. */
export const MAX_CONCURRENCY_UPPER = 64;
export const MAX_PARALLEL_UPPER = 32;
export const MAX_DEPTH_UPPER = 32;
export const RETENTION_UPPER = 10_000;
export const WEB_RESULTS_UPPER = 20;
export const FETCH_SECONDS_MAX = 3_600;
export const FETCH_SECONDS_MIN = 30;

/** Build-time defaults shared by resolution and first-start config generation. */
export function defaultSettings(): ResolvedSettings {
  return {
    agents: {
      maxAgentDepth: DEFAULT_MAX_AGENT_DEPTH,
      maxConcurrency: MAX_CONCURRENCY,
      maxParallelAgents: MAX_PARALLEL_AGENTS,
      retainedTerminalJobs: 25,
      retainedTerminalAgents: 25,
    },
    runtime: {
      deliveryRetryDelayMs: 2_000,
      gitTimeoutMs: 60_000,
      gitLockStaleMs: 30_000,
      gitLockAcquireTimeoutMs: 30_000,
      gitMaxBufferBytes: 16 * MIB,
    },
    channels: {
      maxRootSessions: 200,
      lockStaleMs: 10_000,
      lockUpdateMs: 5_000,
      lockAcquireRetries: 0,
      maxTextLength: 4_000,
      pairingPendingTtlMs: HOUR_MS,
      pairingPendingMax: 3,
      mediaPhotoMaxBytes: 10 * MIB,
      mediaDocumentMaxBytes: 50 * MIB,
      mediaTimeoutMs: 30_000,
    },
    tools: {
      web: {
        searchTimeoutMs: 30_000,
        fetchTimeoutSeconds: FETCH_SECONDS_MIN,
        maxResponseBytes: 5 * MIB,
        defaultNumResults: DEFAULT_WEB_RESULTS,
        defaultSearchType: "auto",
        defaultLivecrawl: "fallback",
      },
    },
    mcp: {
      startupTimeoutMs: 30_000,
      requestTimeoutMs: 30_000,
      reconnectMaxAttempts: 5,
      reconnectBaseDelayMs: 2_000,
      resultMaxText: 50_000,
      resultMaxAttachmentBytes: 5 * MIB,
      oauthCallbackTimeoutMs: 5 * 60 * 1000,
    },
    commands: {
      telegram: { reactionTimeoutMs: 2_500 },
      goalMaxPromptLength: 4_000,
    },
  };
}

/**
 * Create the canonical settings file once, without exposing a partially written
 * file or replacing an existing user-owned file. The temporary file is fully
 * written and synced before an exclusive hard-link publishes it at the target.
 * A concurrent creator wins the link race; all failures are intentionally
 * non-fatal so the extension can continue with resolver defaults.
 */
export function bootstrapSettingsConfig(filePath = settingsConfigPath()): boolean {
  const directory = dirname(filePath);
  let temporaryPath: string | undefined;
  try {
    mkdirSync(directory, { recursive: true });
    const defaults = defaultSettings();
    const template: ResolvedSettings = {
      ...defaults,
      agents: { ...defaults.agents },
      runtime: { ...defaults.runtime },
      channels: { ...defaults.channels },
      tools: { web: { ...defaults.tools.web, exaApiKey: "" } },
      mcp: { ...defaults.mcp },
      commands: { ...defaults.commands, telegram: { ...defaults.commands.telegram } },
    };
    temporaryPath = join(directory, `.${filePath.split(/[\\/]/).pop() ?? "config.json"}.${randomUUID()}.tmp`);
    const fd = openSync(temporaryPath, "wx");
    try {
      writeFileSync(fd, `${JSON.stringify(template, null, 2)}
`, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporaryPath, filePath);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  } finally {
    if (temporaryPath) {
      try { unlinkSync(temporaryPath); } catch { /* another cleanup or failed create */ }
    }
  }
}

/** Read a config file; malformed or missing input degrades to an empty source. */
function readConfigFile(filePath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Apply a source's recognized fields; invalid or unknown fields are skipped. */
function applySource(source: Record<string, unknown>, target: ResolvedSettings): void {
  const agents = source.agents;
  if (isObject(agents)) {
    if (isPosInt(agents.maxAgentDepth, MAX_DEPTH_UPPER)) target.agents.maxAgentDepth = agents.maxAgentDepth;
    if (isPosInt(agents.maxConcurrency, MAX_CONCURRENCY_UPPER)) target.agents.maxConcurrency = agents.maxConcurrency;
    if (isPosInt(agents.maxParallelAgents, MAX_PARALLEL_UPPER)) target.agents.maxParallelAgents = agents.maxParallelAgents;
    if (isUint(agents.retainedTerminalJobs, RETENTION_UPPER)) target.agents.retainedTerminalJobs = agents.retainedTerminalJobs;
    if (isUint(agents.retainedTerminalAgents, RETENTION_UPPER)) target.agents.retainedTerminalAgents = agents.retainedTerminalAgents;
  }
  const runtime = source.runtime;
  if (isObject(runtime)) {
    if (isMs(runtime.deliveryRetryDelayMs, 1, HOUR_MS)) target.runtime.deliveryRetryDelayMs = runtime.deliveryRetryDelayMs;
    if (isMs(runtime.gitTimeoutMs, 1_000, HOUR_MS)) target.runtime.gitTimeoutMs = runtime.gitTimeoutMs;
    if (isMs(runtime.gitLockStaleMs, 1_000, HOUR_MS)) target.runtime.gitLockStaleMs = runtime.gitLockStaleMs;
    if (isMs(runtime.gitLockAcquireTimeoutMs, 1_000, HOUR_MS)) target.runtime.gitLockAcquireTimeoutMs = runtime.gitLockAcquireTimeoutMs;
    if (isPosInt(runtime.gitMaxBufferBytes, 1024 * MIB)) target.runtime.gitMaxBufferBytes = runtime.gitMaxBufferBytes;
  }
  const channels = source.channels;
  if (isObject(channels)) {
    if (isPosInt(channels.maxRootSessions, 100_000)) target.channels.maxRootSessions = channels.maxRootSessions;
    if (isMs(channels.lockStaleMs, 1, HOUR_MS)) target.channels.lockStaleMs = channels.lockStaleMs;
    if (isMs(channels.lockUpdateMs, 1, HOUR_MS)) target.channels.lockUpdateMs = channels.lockUpdateMs;
    if (isUint(channels.lockAcquireRetries, 1_000)) target.channels.lockAcquireRetries = channels.lockAcquireRetries;
    if (isPosInt(channels.maxTextLength, 100_000)) target.channels.maxTextLength = channels.maxTextLength;
    if (isMs(channels.pairingPendingTtlMs, 1_000, DAY_MS)) target.channels.pairingPendingTtlMs = channels.pairingPendingTtlMs;
    if (isPosInt(channels.pairingPendingMax, 100)) target.channels.pairingPendingMax = channels.pairingPendingMax;
    if (isPosInt(channels.mediaPhotoMaxBytes, 100 * MIB)) target.channels.mediaPhotoMaxBytes = channels.mediaPhotoMaxBytes;
    if (isPosInt(channels.mediaDocumentMaxBytes, 512 * MIB)) target.channels.mediaDocumentMaxBytes = channels.mediaDocumentMaxBytes;
    if (isMs(channels.mediaTimeoutMs, 1_000, HOUR_MS)) target.channels.mediaTimeoutMs = channels.mediaTimeoutMs;
  }
  const web = source.tools && isObject(source.tools) ? source.tools.web : undefined;
  if (isObject(web)) {
    if (isMs(web.searchTimeoutMs, 1_000, HOUR_MS)) target.tools.web.searchTimeoutMs = web.searchTimeoutMs;
    if (isPosInt(web.fetchTimeoutSeconds, FETCH_SECONDS_MAX) && web.fetchTimeoutSeconds >= FETCH_SECONDS_MIN) {
      target.tools.web.fetchTimeoutSeconds = web.fetchTimeoutSeconds;
    }
    if (isPosInt(web.maxResponseBytes, 512 * MIB)) target.tools.web.maxResponseBytes = web.maxResponseBytes;
    if (isPosInt(web.defaultNumResults, WEB_RESULTS_UPPER)) target.tools.web.defaultNumResults = web.defaultNumResults;
    if (web.defaultSearchType === "auto" || web.defaultSearchType === "fast" || web.defaultSearchType === "deep") {
      target.tools.web.defaultSearchType = web.defaultSearchType;
    }
    if (web.defaultLivecrawl === "fallback" || web.defaultLivecrawl === "preferred") {
      target.tools.web.defaultLivecrawl = web.defaultLivecrawl;
    }
    if (typeof web.exaApiKey === "string" && web.exaApiKey.length > 0) {
      target.tools.web.exaApiKey = web.exaApiKey;
    }
  }
  const mcp = source.mcp;
  if (isObject(mcp)) {
    if (isMs(mcp.startupTimeoutMs, 1_000, HOUR_MS)) target.mcp.startupTimeoutMs = mcp.startupTimeoutMs;
    if (isMs(mcp.requestTimeoutMs, 1_000, HOUR_MS)) target.mcp.requestTimeoutMs = mcp.requestTimeoutMs;
    if (isPosInt(mcp.reconnectMaxAttempts, 100)) target.mcp.reconnectMaxAttempts = mcp.reconnectMaxAttempts;
    if (isMs(mcp.reconnectBaseDelayMs, 1, HOUR_MS)) target.mcp.reconnectBaseDelayMs = mcp.reconnectBaseDelayMs;
    if (isPosInt(mcp.resultMaxText, 10_000_000)) target.mcp.resultMaxText = mcp.resultMaxText;
    if (isPosInt(mcp.resultMaxAttachmentBytes, 512 * MIB)) target.mcp.resultMaxAttachmentBytes = mcp.resultMaxAttachmentBytes;
    if (isMs(mcp.oauthCallbackTimeoutMs, 1_000, HOUR_MS)) target.mcp.oauthCallbackTimeoutMs = mcp.oauthCallbackTimeoutMs;
  }
  const commands = source.commands;
  if (isObject(commands)) {
    const telegram = commands.telegram;
    if (isObject(telegram) && isMs(telegram.reactionTimeoutMs, 1, HOUR_MS)) {
      target.commands.telegram.reactionTimeoutMs = telegram.reactionTimeoutMs;
    }
    if (isPosInt(commands.goalMaxPromptLength, 1_000_000)) target.commands.goalMaxPromptLength = commands.goalMaxPromptLength;
  }
}

function fileFingerprint(filePath: string): string {
  try {
    const stat = statSync(filePath, { bigint: true });
    // Nanosecond mtime plus size observes equal-size rewrites, creation, and removal.
    return `${stat.mtimeNs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

interface CacheEntry {
  value: ResolvedSettings;
  home: string;
  project: string;
}

const settingsCache = new Map<string, CacheEntry>();
const CONFIG_CACHE_LIMIT = 32;

/** @internal test-only: surface current cache keys to verify no secret leaks. */
function cacheKeysSnapshot(): string {
  return Array.from(settingsCache.keys()).join("|");
}

function copySettings(settings: ResolvedSettings): ResolvedSettings {
  return {
    agents: { ...settings.agents },
    runtime: { ...settings.runtime },
    channels: { ...settings.channels },
    tools: { web: { ...settings.tools.web } },
    mcp: { ...settings.mcp },
    commands: { ...settings.commands, telegram: { ...settings.commands.telegram } },
  };
}

/**
 * Resolve centralized settings for the given project context (cwd). When a
 * project is supplied, its `.pi/pi-c2.json` participates with higher precedence
 * than the home file; otherwise only home and defaults apply.
 */
export function resolveSettingsForProject(project?: string): ResolvedSettings {
  const home = homeRoot();
  const projectFile = project ? join(project, PROJECT_CONFIG_RELATIVE) : undefined;
  const entryKey = `${home}\u0000${project ?? ""}`;

  const homeFingerprint = fileFingerprint(settingsConfigPath());
  const projectFingerprint = projectFile ? fileFingerprint(projectFile) : "none";
  const cached = settingsCache.get(entryKey);
  let value: ResolvedSettings;
  if (cached && cached.home === homeFingerprint && cached.project === projectFingerprint) {
    value = cached.value;
  } else {
    value = defaultSettings();
    applySource(readConfigFile(settingsConfigPath()), value);
    if (projectFile) applySource(readConfigFile(projectFile), value);
    settingsCache.set(entryKey, { value: copySettings(value), home: homeFingerprint, project: projectFingerprint });
    if (settingsCache.size > CONFIG_CACHE_LIMIT) {
      const oldest = settingsCache.keys().next();
      if (!oldest.done) settingsCache.delete(oldest.value as string);
    }
    const debug = globalThis as unknown as { __piC2SettingsDebug__?: { keys: string } };
    if (!debug.__piC2SettingsDebug__) debug.__piC2SettingsDebug__ = { keys: "" };
    debug.__piC2SettingsDebug__.keys = cacheKeysSnapshot();
  }

  value = copySettings(value);

  // Existing environment alias (highest precedence) for the depth override.
  const rawDepth = process.env.PI_C2_MAX_AGENT_DEPTH;
  if (rawDepth !== undefined && rawDepth !== "") {
    const parsed = Number(rawDepth);
    if (isPosInt(parsed, MAX_DEPTH_UPPER)) value.agents.maxAgentDepth = parsed;
  }

  return value;
}

/** Resolve centralized settings with the default (no project) context. */
export function resolveSettings(): ResolvedSettings {
  return resolveSettingsForProject(undefined);
}

/** @internal test-only: force the next resolution to re-read config files. */
export function clearSettingsCache(): void {
  settingsCache.clear();
}
