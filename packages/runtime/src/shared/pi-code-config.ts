import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_AGENT_DEPTH } from "@xzy-ai/core";

/**
 * pi-code runtime configuration.
 *
 * Follows the reference extension-config pattern (pi-messenger): project
 * config overrides the user/extension-level config, env vars override both,
 * and every source falls back to the build-time default. The only supported
 * key today is `maxAgentDepth`:
 *
 * - project:  `<cwd>/.pi/pi-code.json`          `{ "maxAgentDepth": 3 }`
 * - user:     `<agentDir>/pi-code/config.json`  `{ "maxAgentDepth": 3 }`
 * - env:      `PI_CODE_MAX_AGENT_DEPTH=3`
 */
const USER_CONFIG_RELATIVE = join("pi-code", "config.json");
const PROJECT_CONFIG_RELATIVE = join(".pi", "pi-code.json");

/** Parse a positive safe integer from a config file's `maxAgentDepth` key. */
function maxAgentDepthFromFile(configPath: string): number | undefined {
  try {
    if (!existsSync(configPath)) return undefined;
    const raw: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (typeof raw !== "object" || raw === null) return undefined;
    const value = (raw as Record<string, unknown>).maxAgentDepth;
    if (typeof value !== "number") return undefined;
    if (!Number.isSafeInteger(value) || value < 1) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/** Parse a positive safe integer from the environment. */
function maxAgentDepthFromEnv(): number | undefined {
  const raw = process.env.PI_CODE_MAX_AGENT_DEPTH;
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return undefined;
  return parsed;
}

/**
 * Resolve the configured maximum recursive agent depth.
 *
 * Precedence: `PI_CODE_MAX_AGENT_DEPTH` env > project `.pi/pi-code.json` >
 * user `<agentDir>/pi-code/config.json` > `DEFAULT_MAX_AGENT_DEPTH`. Reads are
 * lazy so a reloaded extension picks up a changed value without a restart.
 * Invalid values are ignored (treated as unset), never fatal.
 *
 * Results are cached per (env, config-file stat) fingerprint so the hot spawn
 * path does not re-read either config file for every child; the cache
 * invalidates whenever a config file is created, modified, or removed.
 */
const configCache = new Map<string, number>();
const CONFIG_CACHE_LIMIT = 32;

/** Stat fingerprint: mtimeNs+size, or the literal `missing` when unreadable. */
function fileFingerprint(configPath: string): string {
  try {
    const stat = statSync(configPath, { bigint: true });
    // mtimeNs (bigint, nanosecond resolution) so successive writes within the
    // same millisecond with equal byte sizes still invalidate the cache.
    return `${stat.mtimeNs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

export function maxAgentDepth(cwd?: string): number {
  const fromEnv = maxAgentDepthFromEnv();
  if (fromEnv !== undefined) return fromEnv;

  const projectPath = cwd ? join(cwd, PROJECT_CONFIG_RELATIVE) : undefined;
  const userPath = join(getAgentDir(), USER_CONFIG_RELATIVE);
  const key = `${cwd ?? ""}\u0000${projectPath ? fileFingerprint(projectPath) : "none"}\u0000${fileFingerprint(userPath)}`;
  const cached = configCache.get(key);
  if (cached !== undefined) return cached;

  // Resolve low-to-high precedence so project configuration overrides the
  // user-level fallback, matching the uncached behavior.
  let value = maxAgentDepthFromFile(userPath) ?? DEFAULT_MAX_AGENT_DEPTH;
  if (projectPath) {
    const fromProject = maxAgentDepthFromFile(projectPath);
    if (fromProject !== undefined) value = fromProject;
  }

  configCache.set(key, value);
  if (configCache.size > CONFIG_CACHE_LIMIT) {
    const oldest = configCache.keys().next();
    if (!oldest.done) configCache.delete(oldest.value as string);
  }
  return value;
}