import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { DEFAULT_AGENT } from "@xzy-ai/core";
import type { DiscoveredAgent } from "@xzy-ai/core";
import type { AgentDiscovery } from "@xzy-ai/core";

/**
 * Project agent ecosystems, in precedence order. A project agent in an earlier
 * ecosystem overrides a same-name agent in a later one (and in the user dir).
 */
const PROJECT_ECOSYSTEMS = [".pi", ".claude", ".opencode"] as const;

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

  return {
    name,
    description,
    isDefault: false,
    tools: tools && tools.length > 0 ? tools : undefined,
    model,
    systemPrompt: body,
    source,
    filePath,
  };
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
 * This accepts projects that use only `.claude/agents` or `.opencode/agents`;
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
 * `.pi/agents` up the tree, then `.claude/agents` and `.opencode/agents` within
 * the same project root. Project agents override same-name user agents; within
 * project ecosystems, `.pi` > `.claude` > `.opencode`.
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

  // Merge with precedence: user agents first, then project agents in reverse
  // ecosystem order. Later entries overwrite same names, so a project agent
  // overrides a same-name user agent and `.pi` wins over `.claude`, which wins
  // over `.opencode`.
  const byName = new Map<string, DiscoveredAgent>();
  for (const agent of userAgents) byName.set(agent.name, agent);
  for (const agent of [...projectAgents].reverse()) byName.set(agent.name, agent);

  return {
    resolve(name) {
      if (name === DEFAULT_AGENT.name) return DEFAULT_AGENT;
      return byName.get(name);
    },
    all() {
      return Array.from(byName.values());
    },
  };
}