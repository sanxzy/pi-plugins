import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createAgentDiscovery, createCachedAgentDiscovery, clearAgentDiscoveryCache } from "@xzy-ai/runtime";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-c2-agent-discovery-"));
}

test("frontmatter model and thinking are parsed from a .claude agent", () => {
  const root = tmpRoot();
  try {
    const agentsDir = join(root, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "explore.md"),
      [
        "---",
        "name: explore",
        "description: Explore",
        "model: commandcode/deepseek/deepseek-v4-flash",
        "thinking: high",
        "---",
        "",
        "Explore.",
      ].join("\n"),
      "utf-8",
    );
    const discovery = createAgentDiscovery(root);
    const agent = discovery.resolve("explore");
    assert.ok(agent);
    assert.equal(agent.model, "commandcode/deepseek/deepseek-v4-flash");
    assert.equal(agent.thinking, "high");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cached discovery clears so a model edit is observed", () => {
  const root = tmpRoot();
  try {
    const agentsDir = join(root, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });
    const file = join(agentsDir, "explore.md");
    writeFileSync(file, "---\nname: explore\ndescription: d\nmodel: anthropic/claude-sonnet-4-5\n---\nbody", "utf-8");
    const cached = createCachedAgentDiscovery(root);
    assert.equal(cached.resolve("explore")?.model, "anthropic/claude-sonnet-4-5");
    writeFileSync(file, "---\nname: explore\ndescription: d\nmodel: commandcode/deepseek/deepseek-v4-flash\n---\nbody", "utf-8");
    clearAgentDiscoveryCache();
    const resolved = createCachedAgentDiscovery(root).resolve("explore");
    assert.ok(resolved, "agent resolves after cache clear");
    assert.equal(resolved.model, "commandcode/deepseek/deepseek-v4-flash");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
