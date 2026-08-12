import { existsSync, readFileSync } from "node:fs";
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
 */
export function maxAgentDepth(cwd?: string): number {
  const fromEnv = maxAgentDepthFromEnv();
  if (fromEnv !== undefined) return fromEnv;

  if (cwd) {
    const fromProject = maxAgentDepthFromFile(join(cwd, PROJECT_CONFIG_RELATIVE));
    if (fromProject !== undefined) return fromProject;
  }

  const fromUser = maxAgentDepthFromFile(join(getAgentDir(), USER_CONFIG_RELATIVE));
  if (fromUser !== undefined) return fromUser;

  return DEFAULT_MAX_AGENT_DEPTH;
}