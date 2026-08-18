import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { registerManageAgentModel } from "../src/registrations/manage-agent-model-command.ts";
import { createManageAgentModelController } from "../src/registrations/manage-agent-model.ts";

const AGENT_FILE = `---
name: research
description: Deep research agent
model: anthropic/claude-sonnet-4-5
---
Research carefully.
`;

function modelRegistry(models: Array<{ provider: string; id: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> }>): Pick<ModelRegistry, "getAvailable"> {
  return {
    getAvailable: () => models as unknown as ModelRegistry["getAvailable"] extends () => infer R ? R : never,
  };
}

function fixture(): { cwd: string; agentsDir: string; agentFilePath: string; cleanup(): void } {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-agent-model-"));
  const agentsDir = join(cwd, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  const agentFilePath = join(agentsDir, "research.md");
  writeFileSync(agentFilePath, AGENT_FILE, "utf-8");
  return {
    cwd,
    agentsDir,
    agentFilePath,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

test("listAgents exposes discovered agents with their frontmatter model", async () => {
  const { cwd, cleanup } = fixture();
  try {
    const controller = createManageAgentModelController({ cwd, modelRegistry: modelRegistry([]) });
    const agents = await controller.listAgents();
    assert.equal(agents.length, 1);
    assert.equal(agents[0]!.name, "research");
    assert.equal(agents[0]!.model, "anthropic/claude-sonnet-4-5");
  } finally {
    cleanup();
  }
});

test("listModels formats models exactly like /model", async () => {
  const { cwd, cleanup } = fixture();
  try {
    const controller = createManageAgentModelController({
      cwd,
      modelRegistry: modelRegistry([
        { provider: "anthropic", id: "claude-sonnet-4-5" },
        { provider: "openai", id: "gpt-5" },
      ]),
    });
    const models = await controller.listModels();
    assert.deepEqual(models.map((m) => m.reference), ["anthropic/claude-sonnet-4-5", "openai/gpt-5"]);
  } finally {
    cleanup();
  }
});

test("setModel rewrites the frontmatter model and clears discovery cache", async () => {
  const { cwd, agentFilePath, cleanup } = fixture();
  try {
    const controller = createManageAgentModelController({
      cwd,
      modelRegistry: modelRegistry([{ provider: "openai", id: "gpt-5" }]),
    });
    const result = await controller.setModel("research", "openai/gpt-5");
    assert.deepEqual(result, { ok: true, message: 'Agent "research" model set to openai/gpt-5.' });
    const content = readFileSync(agentFilePath, "utf-8");
    assert.match(content, /^model: openai\/gpt-5$/m);
    assert.match(content, /Research carefully\./);
    assert.match(content, /^name: research$/m);
    // The discovery cache is invalidated so the agent tool sees the new model.
    const agents = await controller.listAgents();
    assert.equal(agents[0]!.model, "openai/gpt-5");
  } finally {
    cleanup();
  }
});

test("setModel with a thinking level writes both keys", async () => {
  const { cwd, agentFilePath, cleanup } = fixture();
  try {
    const controller = createManageAgentModelController({
      cwd,
      modelRegistry: modelRegistry([{ provider: "anthropic", id: "claude-sonnet-4-5", reasoning: true }]),
    });
    const result = await controller.setModel("research", "anthropic/claude-sonnet-4-5", "high");
    assert.deepEqual(result, { ok: true, message: 'Agent "research" model set to anthropic/claude-sonnet-4-5, thinking high.' });
    const content = readFileSync(agentFilePath, "utf-8");
    assert.match(content, /^model: anthropic\/claude-sonnet-4-5$/m);
    assert.match(content, /^thinking: high$/m);
    assert.equal((await controller.listAgents())[0]!.thinking, "high");
  } finally {
    cleanup();
  }
});

test("removeModel deletes both the model and thinking keys", async () => {
  const { cwd, agentFilePath, cleanup } = fixture();
  try {
    const controller = createManageAgentModelController({ cwd, modelRegistry: modelRegistry([]) });
    // Add thinking first.
    await controller.setModel("research", "anthropic/claude-sonnet-4-5", "high");
    const result = await controller.removeModel("research");
    assert.deepEqual(result, { ok: true, message: 'Agent "research" model removed.' });
    const content = readFileSync(agentFilePath, "utf-8");
    assert.doesNotMatch(content, /^model:/m);
    assert.doesNotMatch(content, /^thinking:/m);
    const agents = await controller.listAgents();
    assert.equal(agents[0]!.model, undefined);
    assert.equal(agents[0]!.thinking, undefined);
  } finally {
    cleanup();
  }
});

test("listThinkingLevels returns only off for non-reasoning models", async () => {
  const { cwd, cleanup } = fixture();
  try {
    const controller = createManageAgentModelController({
      cwd,
      modelRegistry: modelRegistry([{ provider: "openai", id: "gpt-5", reasoning: false }]),
    });
    assert.deepEqual(await controller.listThinkingLevels("openai/gpt-5"), [{ level: "off", label: "off" }]);
  } finally {
    cleanup();
  }
});

test("listThinkingLevels returns extended levels for reasoning models", async () => {
  const { cwd, cleanup } = fixture();
  try {
    const controller = createManageAgentModelController({
      cwd,
      modelRegistry: modelRegistry([{ provider: "anthropic", id: "claude-sonnet-4-5", reasoning: true }]),
    });
    const levels = await controller.listThinkingLevels("anthropic/claude-sonnet-4-5");
    assert.ok(levels.length > 1, "reasoning models expose more than off");
    assert.ok(levels.some((level) => level.level === "high"));
  } finally {
    cleanup();
  }
});

test("removeModel deletes the frontmatter model line", async () => {
  const { cwd, agentFilePath, cleanup } = fixture();
  try {
    const controller = createManageAgentModelController({ cwd, modelRegistry: modelRegistry([]) });
    const result = await controller.removeModel("research");
    assert.deepEqual(result, { ok: true, message: 'Agent "research" model removed.' });
    const content = readFileSync(agentFilePath, "utf-8");
    assert.doesNotMatch(content, /^model:/m);
    assert.match(content, /^name: research$/m);
    assert.match(content, /Research carefully\./);
    assert.equal((await controller.listAgents())[0]!.model, undefined);
  } finally {
    cleanup();
  }
});

test("setModel on an unknown agent reports an error", async () => {
  const { cwd, cleanup } = fixture();
  try {
    const controller = createManageAgentModelController({ cwd, modelRegistry: modelRegistry([]) });
    assert.equal((await controller.setModel("nope", "openai/gpt-5")).ok, false);
  } finally {
    cleanup();
  }
});

test("/manage-agent-model is registered and maps wizard results to notifications", async () => {
  const handlers = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const notifications: Array<[string, string]> = [];
  const pi = {
    registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
      handlers.set(name, options.handler);
    },
  } as unknown as ExtensionAPI;
  registerManageAgentModel(pi);
  assert.equal(handlers.has("manage-agent-model"), true);
  const ctxFor = (result: unknown): ExtensionCommandContext => ({
    mode: "tui",
    hasUI: true,
    signal: undefined,
    cwd: "/tmp",
    modelRegistry: modelRegistry([]),
    ui: {
      custom: async () => result,
      notify: (message: string, kind?: string) => notifications.push([message, kind ?? "info"] as [string, string]),
    },
  } as unknown as ExtensionCommandContext);
  await handlers.get("manage-agent-model")!("", ctxFor({ status: "saved", message: "Agent model set." }));
  await handlers.get("manage-agent-model")!("", ctxFor({ status: "error", message: "Broken" }));
  await handlers.get("manage-agent-model")!("", ctxFor({ status: "cancelled" }));
  assert.deepEqual(notifications, [
    ["Agent model set.", "info"],
    ["Broken", "error"],
    ["Agent model management cancelled", "info"],
  ]);
});

test("/manage-agent-model is gated to interactive TUI", async () => {
  const handlers = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const notifications: string[] = [];
  const pi = {
    registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
      handlers.set(name, options.handler);
    },
  } as unknown as ExtensionAPI;
  registerManageAgentModel(pi);
  await handlers.get("manage-agent-model")!("", {
    mode: "rpc",
    hasUI: true,
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionCommandContext);
  assert.match(notifications[0]!, /requires an interactive TUI/);
});
