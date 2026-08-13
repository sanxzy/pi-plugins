import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentDiscovery, createCachedAgentDiscovery, clearAgentDiscoveryCache } from "@xzy-ai/runtime";
import type { DiscoveredAgent } from "@xzy-ai/core";

/** Assert a resolved name is a discovered agent. */
function asDiscovered(agent: DiscoveredAgent | undefined): DiscoveredAgent {
  assert.ok(agent);
  return agent;
}

/**
 * Phase 8: agent discovery.
 *
 * The discovery seam is exercised against real temp directories so the
 * filesystem precedence and skip-on-invalid behavior are covered without the
 * PI SDK. The user agents directory is resolved through `getAgentDir()`, which
 * honors the `PI_CODING_AGENT_DIR` environment variable.
 */

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-agents-"));
}

function processEnv(): NodeJS.Process["env"] {
  return process.env;
}

function writeAgent(
  dir: string,
  name: string,
  frontmatter: Record<string, string>,
  body: string,
): void {
  mkdirSync(dir, { recursive: true });
  const lines = Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  const content = body.length > 0 ? `---\n${lines}\n---\n${body}` : `---\n${lines}\n---`;
  writeFileSync(join(dir, `${name}.md`), content, "utf-8");
}

/** Discover agents from `cwd`, with the user dir rooted at `userAgentDir`. */
function discover(cwd: string, userAgentDir: string): ReturnType<typeof createAgentDiscovery> {
  const previous = processEnv().PI_CODING_AGENT_DIR;
  processEnv().PI_CODING_AGENT_DIR = userAgentDir;
  try {
    return createAgentDiscovery(cwd);
  } finally {
    if (previous === undefined) {
      delete processEnv().PI_CODING_AGENT_DIR;
    } else {
      processEnv().PI_CODING_AGENT_DIR = previous;
    }
  }
}

test("a valid project agent in .pi/agents is discovered with its metadata and body", () => {
  const root = tmpRoot();
  try {
    writeAgent(
      join(root, ".pi", "agents"),
      "code-reviewer",
      { name: "code-reviewer", description: "Reviews focused code changes", tools: "read, grep" },
      "You are a meticulous code reviewer.\n\nReturn findings only.",
    );
    const discovery = discover(root, join(root, "nouser"));
    const agent = discovery.resolve("code-reviewer");
    assert.ok(agent);
    assert.equal(agent.name, "code-reviewer");
    assert.equal(agent.description, "Reviews focused code changes");
    assert.deepEqual(agent.tools, ["read", "grep"]);
    assert.equal(agent.model, undefined);
    assert.equal(agent.systemPrompt, "You are a meticulous code reviewer.\n\nReturn findings only.");
    assert.equal(agent.source, "project");
    assert.equal(agent.filePath, join(root, ".pi", "agents", "code-reviewer.md"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project agents are discovered with .pi > .claude > .agents precedence", () => {
  const root = tmpRoot();
  try {
    writeAgent(
      join(root, ".pi", "agents"),
      "reviewer",
      { name: "reviewer", description: "pi reviewer" },
      "pi body",
    );
    writeAgent(
      join(root, ".claude", "agents"),
      "reviewer",
      { name: "reviewer", description: "claude reviewer" },
      "claude body",
    );
    writeAgent(
      join(root, ".agents", "agents"),
      "codegen",
      { name: "codegen", description: "agents codegen" },
      "agents body",
    );

    const discovery = discover(root, join(root, "nouser"));
    const reviewer = asDiscovered(discovery.resolve("reviewer"));
    assert.equal(reviewer.systemPrompt, "pi body");
    assert.equal(reviewer.description, "pi reviewer");
    const codegen = asDiscovered(discovery.resolve("codegen"));
    assert.equal(codegen.systemPrompt, "agents body");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a higher-priority file wins a filename collision even with a different agent name", () => {
  const root = tmpRoot();
  try {
    writeAgent(
      join(root, ".agents", "agents"),
      "shared-file",
      { name: "low-priority", description: "lower priority" },
      "low body",
    );
    writeAgent(
      join(root, ".pi", "agents"),
      "shared-file",
      { name: "high-priority", description: "higher priority" },
      "high body",
    );

    const discovery = discover(root, join(root, "nouser"));
    assert.equal(discovery.resolve("low-priority"), undefined);
    const high = asDiscovered(discovery.resolve("high-priority"));
    assert.equal(high.description, "higher priority");
    assert.deepEqual(discovery.all().map((agent) => agent.name), ["high-priority"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a nested cwd discovers the nearest project agents dir", () => {
  const root = tmpRoot();
  try {
    writeAgent(
      join(root, ".pi", "agents"),
      "nested-agent",
      { name: "nested-agent", description: "found by ancestor walk" },
      "nested body",
    );
    const discovery = discover(join(root, "packages", "app"), join(root, "nouser"));
    const agent = asDiscovered(discovery.resolve("nested-agent"));
    assert.equal(agent.systemPrompt, "nested body");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a same-name user agent is overridden by a project agent", () => {
  const root = tmpRoot();
  try {
    const userDir = join(root, "user");
    writeAgent(
      join(userDir, "agents"),
      "reviewer",
      { name: "reviewer", description: "user reviewer" },
      "user body",
    );
    writeAgent(
      join(root, ".pi", "agents"),
      "reviewer",
      { name: "reviewer", description: "project reviewer" },
      "project body",
    );

    const discovery = discover(root, userDir);
    const resolved = asDiscovered(discovery.resolve("reviewer"));
    assert.equal(resolved.source, "project");
    assert.equal(resolved.systemPrompt, "project body");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a user-only agent is discovered from getAgentDir()/agents", () => {
  const root = tmpRoot();
  try {
    const userDir = join(root, "user");
    writeAgent(
      join(userDir, "agents"),
      "user-tool",
      { name: "user-tool", description: "user only" },
      "user body",
    );
    const discovery = discover(root, userDir);
    const agent = asDiscovered(discovery.resolve("user-tool"));
    assert.equal(agent.source, "user");
    assert.equal(agent.systemPrompt, "user body");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown agent name resolves to undefined", () => {
  const root = tmpRoot();
  try {
    const discovery = discover(root, join(root, "nouser"));
    assert.equal(discovery.resolve("does-not-exist"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid agent files are skipped without erroring the orchestrator", () => {
  const root = tmpRoot();
  try {
    const agentsDir = join(root, ".pi", "agents");
    // Missing description.
    writeAgent(agentsDir, "no-desc", { name: "no-desc" }, "body");
    // Missing name.
    writeAgent(agentsDir, "no-name", { description: "no name" }, "body");
    // Malformed frontmatter (YAML parser throws).
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "bad-yaml.md"),
      "---\nname: broken\n: : :\n---\nbody",
      "utf-8",
    );
    // A non-Markdown file is ignored.
    writeFileSync(join(agentsDir, "notes.txt"), "not an agent", "utf-8");

    const discovery = discover(root, join(root, "nouser"));
    assert.equal(discovery.resolve("no-desc"), undefined);
    assert.equal(discovery.resolve("no-name"), undefined);
    assert.equal(discovery.resolve("bad-yaml"), undefined);
    assert.equal(discovery.resolve("notes"), undefined);
    // A valid sibling still resolves.
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit tools list is parsed and absent tools stay undefined", () => {
  const root = tmpRoot();
  try {
    writeAgent(
      join(root, ".pi", "agents"),
      "with-tools",
      { name: "with-tools", description: "d", tools: "read, bash, grep" },
      "body",
    );
    writeAgent(
      join(root, ".pi", "agents"),
      "no-tools",
      { name: "no-tools", description: "d" },
      "body",
    );
    const discovery = discover(root, join(root, "nouser"));
    const withTools = asDiscovered(discovery.resolve("with-tools"));
    assert.deepEqual(withTools.tools, ["read", "bash", "grep"]);
    const noTools = asDiscovered(discovery.resolve("no-tools"));
    assert.equal(noTools.tools, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit model is preserved and an absent model stays undefined", () => {
  const root = tmpRoot();
  try {
    writeAgent(
      join(root, ".pi", "agents"),
      "with-model",
      { name: "with-model", description: "d", model: "anthropic/claude-opus-4-5" },
      "body",
    );
    writeAgent(
      join(root, ".pi", "agents"),
      "no-model",
      { name: "no-model", description: "d" },
      "body",
    );
    const discovery = discover(root, join(root, "nouser"));
    const withModel = asDiscovered(discovery.resolve("with-model"));
    assert.equal(withModel.model, "anthropic/claude-opus-4-5");
    const noModel = asDiscovered(discovery.resolve("no-model"));
    assert.equal(noModel.model, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all() returns discovered agents with project precedence", () => {
  const root = tmpRoot();
  try {
    writeAgent(
      join(root, ".pi", "agents"),
      "reviewer",
      { name: "reviewer", description: "project" },
      "project body",
    );
    writeAgent(join(root, "user", "agents"), "user-agent", { name: "user-agent", description: "u" }, "u");
    const discovery = discover(root, join(root, "user"));
    const all = discovery.all();
    assert.equal(all.length, 2);
    assert.ok(all.some((a) => a.name === "user-agent"));
    const reviewer = all.find((a) => a.name === "reviewer");
    assert.ok(reviewer);
    assert.equal(reviewer.source, "project");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("cached agent discovery reuses one scan and invalidates on ecosystem change or explicit clear", () => {
  const root = tmpRoot();
  const userDir = join(root, "user");
  writeAgent(join(userDir, "agents"), "alpha", { name: "alpha", description: "a" }, "body");
  const previous = processEnv().PI_CODING_AGENT_DIR;
  processEnv().PI_CODING_AGENT_DIR = userDir;
  try {
    const first = createCachedAgentDiscovery(root);
    const second = createCachedAgentDiscovery(root);
    assert.equal(first, second, "an unchanged ecosystem reuses the discovery object (no rescan)");
    assert.ok(first.resolve("alpha"));

    // A different cwd with the same agent ecosystems reuses the same scan: the
    // cache is keyed by the ecosystem directories, not by cwd alone.
    assert.equal(createCachedAgentDiscovery(join(root, "packages", "app")), first);

    // Adding an agent file changes the ecosystem fingerprint (entry count and
    // mtime), so the next call rescans and sees the new agent.
    writeAgent(join(userDir, "agents"), "beta", { name: "beta", description: "b" }, "body");
    const third = createCachedAgentDiscovery(root);
    assert.notEqual(third, first, "ecosystem changes invalidate the cache");
    assert.ok(third.resolve("beta"));

    // Explicit invalidation forces a fresh scan even when nothing changed.
    clearAgentDiscoveryCache();
    const fourth = createCachedAgentDiscovery(root);
    assert.notEqual(fourth, third, "clearAgentDiscoveryCache forces a fresh scan");
    assert.ok(fourth.resolve("alpha"));
    assert.ok(fourth.resolve("beta"));
  } finally {
    clearAgentDiscoveryCache();
    if (previous === undefined) {
      delete processEnv().PI_CODING_AGENT_DIR;
    } else {
      processEnv().PI_CODING_AGENT_DIR = previous;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
