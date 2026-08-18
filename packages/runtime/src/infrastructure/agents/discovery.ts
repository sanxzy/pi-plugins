import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { DiscoveredAgent } from "@xzy-ai/core";
import type { AgentDiscovery } from "@xzy-ai/core";

/**
 * Project agent ecosystems, in precedence order. A project agent in an earlier
 * ecosystem overrides a same-name agent in a later one (and in the user dir).
 */
const PROJECT_ECOSYSTEMS = [".pi", ".claude", ".agents"] as const;

/**
 * Parse a single agent Markdown file into a discovered agent.
 *
 * Returns `undefined` for any invalid file: a missing `name` or `description`,
 * malformed frontmatter, or an unreadable path. The frontmatter parser throws
 * on malformed YAML, so each file is parsed defensively and never errors the
 * orchestrator.
 */
function parseAgentFile(filePath: string, source: "user" | "project"): DiscoveredAgent | undefined {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }

  let frontmatter: Record<string, unknown>;
  let body: string;
  try {
    ({ frontmatter, body } = parseFrontmatter(content));
  } catch {
    return undefined;
  }

  const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  if (!name || !description) {
    return undefined;
  }

  const tools = splitTools(frontmatter.tools);
  const model = typeof frontmatter.model === "string" && frontmatter.model.trim() ? frontmatter.model.trim() : undefined;
  const thinking = normalizeThinking(frontmatter.thinking);

  return {
    name,
    description,
    tools: tools && tools.length > 0 ? tools : undefined,
    model,
    thinking,
    systemPrompt: body,
    source,
    filePath,
  };
}

/** The thinking levels the SDK accepts for a model. */
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Normalize a `thinking` frontmatter value to a known level, or `undefined`. */
function normalizeThinking(value: unknown): ThinkingLevel | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return THINKING_LEVELS.includes(trimmed as ThinkingLevel) ? (trimmed as ThinkingLevel) : undefined;
}

/** Split a comma-delimited `tools:` frontmatter value into trimmed names. */
function splitTools(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const tools = value
    .split(",")
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0);
  return tools.length > 0 ? tools : undefined;
}

/** True when `path` is a readable directory. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** List the agent files in a directory, skipping invalid entries. */
function loadAgentsFromDir(dir: string, source: "user" | "project"): DiscoveredAgent[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const agents: DiscoveredAgent[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = join(dir, entry);
    if (!isDirectory(filePath)) {
      const agent = parseAgentFile(filePath, source);
      if (agent) agents.push(agent);
    }
  }
  return agents;
}

/**
 * Find the nearest project root containing any supported agent ecosystem.
 *
 * This accepts projects that use only `.claude/agents` or `.agents/agents`;
 * the three directories are then merged by their fixed precedence order.
 */
function findProjectRoot(cwd: string): string | undefined {
  let current = cwd;
  for (;;) {
    if (PROJECT_ECOSYSTEMS.some((ecosystem) => isDirectory(join(current, ecosystem, "agents")))) {
      return current;
    }
    const parent = join(current, "..");
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Create the agent-discovery seam.
 *
 * User agents are scanned under `getAgentDir()/agents` (the PI-resolved user
 * directory — no hardcoded path). Project agents are scanned under the nearest
 * `.pi/agents` up the tree, then `.claude/agents` and `.agents/agents` within
 * the same project root. Project agents override same-name user agents; within
 * project ecosystems, `.pi` > `.claude` > `.agents`.
 */
export function createAgentDiscovery(cwd: string): AgentDiscovery {
  const userDir = join(getAgentDir(), "agents");
  const userAgents = loadAgentsFromDir(userDir, "user");

  const projectRoot = findProjectRoot(cwd);
  const projectAgents =
    projectRoot === undefined
      ? []
      : PROJECT_ECOSYSTEMS.flatMap((ecosystem) =>
          loadAgentsFromDir(join(projectRoot, ecosystem, "agents"), "project"),
        );

  // Merge with precedence: user agents first, then project agents from lowest
  // to highest project precedence (`.agents` < `.claude` < `.pi`). Later
  // entries win when either the frontmatter name or filename collides, so the
  // highest-precedence definition wins. The filename check prevents
  // lower-priority definitions from surviving under the same agent file name.
  const byFilePath = new Map<string, DiscoveredAgent>();
  for (const agent of [...userAgents, ...[...projectAgents].reverse()]) {
    const fileName = basename(agent.filePath);
    for (const [path, existing] of byFilePath) {
      const existingFileName = basename(existing.filePath);
      if (existing.name === agent.name || existingFileName === fileName) {
        byFilePath.delete(path);
      }
    }
    byFilePath.set(agent.filePath, agent);
  }

  const byName = new Map<string, DiscoveredAgent>();
  for (const agent of byFilePath.values()) byName.set(agent.name, agent);

  return {
    resolve(name) {
      return byName.get(name);
    },
    all() {
      return Array.from(byName.values());
    },
  };
}

/**
 * Fingerprint the ecosystem directories a discovery scan depends on.
 *
 * Includes the resolved user agents directory (so a `PI_CODING_AGENT_DIR`
 * change invalidates) and every project ecosystem directory, plus each
 * directory's entry count and mtime so adding, removing, or editing an agent
 * Markdown file changes the key and forces a fresh scan.
 */
function ecosystemFingerprint(cwd: string): string {
  const userDir = join(getAgentDir(), "agents");
  const projectRoot = findProjectRoot(cwd);
  const directories = projectRoot === undefined
    ? [userDir]
    : [userDir, ...PROJECT_ECOSYSTEMS.map((ecosystem) => join(projectRoot, ecosystem, "agents"))];
  // The nearest project root plus the user directory fully determines the
  // merged ecosystem. Cwd itself is not part of the identity, so calls from
  // nested folders reuse one scan for the same project.
  const parts = [projectRoot ?? ""];
  for (const directory of directories) {
    try {
      const entries = readdirSync(directory).sort();
      const signatures = entries.map((entry) => {
        try {
          const path = join(directory, entry);
          // mtimeNs (bigint, nanosecond resolution) so successive writes
          // within the same millisecond still invalidate the cache.
          const stat = statSync(path, { bigint: true });
          return `${entry}:${stat.mtimeNs}:${stat.size}`;
        } catch {
          return `${entry}:unstatable`;
        }
      });
      parts.push(`${directory}:${signatures.join(",")}`);
    } catch {
      parts.push(`${directory}:missing`);
    }
  }
  return parts.join("\u0000");
}

/** Module-level discovery cache keyed by the ecosystem fingerprint. */
const discoveryCache = new Map<string, AgentDiscovery>();
const DISCOVERY_CACHE_LIMIT = 32;

/** Drop every cached agent discovery; the next call rescans from disk. */
export function clearAgentDiscoveryCache(): void {
  discoveryCache.clear();
}

/**
 * Create an agent discovery, reusing the last scan for the same ecosystem.
 *
 * `agent` calls and `agent_list` calls hit this on the hot tool path; the
 * cached discovery is immutable after creation and is invalidated by any
 * change to the ecosystem directories or by `clearAgentDiscoveryCache()`.
 */
export function createCachedAgentDiscovery(cwd: string): AgentDiscovery {
  const key = ecosystemFingerprint(cwd);
  const cached = discoveryCache.get(key);
  if (cached) return cached;
  const discovery = createAgentDiscovery(cwd);
  discoveryCache.set(key, discovery);
  if (discoveryCache.size > DISCOVERY_CACHE_LIMIT) {
    const oldest = discoveryCache.keys().next();
    if (!oldest.done && oldest.value !== undefined) discoveryCache.delete(oldest.value);
  }
  return discovery;
}
