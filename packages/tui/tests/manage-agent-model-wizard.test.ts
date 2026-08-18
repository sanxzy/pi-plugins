import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { TUI } from "@earendil-works/pi-tui";
import type {
  ManageAgentModelAgentItem,
  ManageAgentModelController,
  ManageAgentModelModelItem,
} from "@xzy-ai/tui";
import { ManageAgentModelWizard, type ManageAgentModelResult } from "../src/manage-agent-model-wizard.ts";

function tui(): TUI {
  return { terminal: { rows: 24 }, requestRender: () => {} } as unknown as TUI;
}

const theme = { fg: (_color: string, text: string) => text };

const AGENTS: ManageAgentModelAgentItem[] = [
  { name: "research", description: "Deep research", model: "anthropic/claude-sonnet-4-5", filePath: "/tmp/research.md" },
  { name: "writer", description: "Writes docs", filePath: "/tmp/writer.md" },
];

const MODELS: ManageAgentModelModelItem[] = [
  { provider: "anthropic", id: "claude-sonnet-4-5", reference: "anthropic/claude-sonnet-4-5" },
  { provider: "openai", id: "gpt-5", reference: "openai/gpt-5" },
];

function controller(overrides: Partial<ManageAgentModelController> = {}): ManageAgentModelController {
  return {
    listAgents: async () => AGENTS,
    listModels: async () => MODELS,
    listThinkingLevels: async () => [{ level: "off", label: "off" }, { level: "high", label: "high" }],
    setModel: async () => ({ ok: true, message: "Agent model set." }),
    removeModel: async () => ({ ok: true, message: "Agent model removed." }),
    cancel: async () => {
      await undefined;
    },
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function lines(component: { render(width: number): string[] }): string[] {
  return stripVTControlCharacters(component.render(60).join("\n")).split("\n");
}

function resultPromise(): { promise: Promise<ManageAgentModelResult>; resolve: (result: ManageAgentModelResult) => void } {
  let resolve!: (result: ManageAgentModelResult) => void;
  const promise = new Promise<ManageAgentModelResult>((next) => { resolve = next; });
  return { promise, resolve };
}

test("the agent list caps at 10 visible items and scrolls with the selection", async () => {
  const manyAgents: ManageAgentModelAgentItem[] = Array.from({ length: 15 }, (_, i) => ({
    name: `agent-${String(i + 1).padStart(2, "0")}`,
    description: `agent number ${i + 1}`,
    filePath: `/tmp/agent-${i + 1}.md`,
  }));
  const ctl = controller({ listAgents: async () => manyAgents });
  const result = resultPromise();
  const wizard = new ManageAgentModelWizard({ tui: tui(), theme, controller: ctl, done: result.resolve });
  await flush();

  // Enter the agent step.
  wizard.handleInput("\r");
  await flush();
  const initial = lines(wizard).filter((line) => /(?:>\s*)?\d+\. agent-/.test(line));
  assert.equal(initial.length, 10, "only 10 agent rows render");
  assert.ok(initial[0]!.includes("1. agent-01"));
  assert.ok(initial[9]!.includes("10. agent-10"));
  assert.ok(!initial.some((line) => line.includes("agent-11")));
  assert.ok(lines(wizard).some((line) => line.includes("1–10 of 15")));

  // Move to the last item; the window anchors at the bottom to keep it visible.
  for (let i = 0; i < 14; i++) wizard.handleInput("\x1b[B");
  await flush();
  const scrolled = lines(wizard).filter((line) => /(?:>\s*)?\d+\. agent-/.test(line));
  assert.ok(scrolled[0]!.includes("6. agent-06"), "window scrolls to keep the selection visible");
  assert.ok(scrolled[9]!.includes("15. agent-15"));
  assert.ok(lines(wizard).some((line) => line.includes("6–15 of 15")));
});

test("renders the action menu and flows set → agent → model → thinking → result", async () => {
  const ctl = controller();
  const result = resultPromise();
  const wizard = new ManageAgentModelWizard({ tui: tui(), theme, controller: ctl, done: result.resolve });
  await flush();
  assert.ok(lines(wizard).some((line) => line.includes("Manage agent model")));
  assert.ok(lines(wizard).some((line) => line.includes("Set / replace agent model")));

  // Select "Set / replace agent model".
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("select agent")));
  assert.ok(lines(wizard).some((line) => line.includes("research")));

  // Filter agents by "writ".
  for (const char of "writ") wizard.handleInput(char);
  assert.ok(lines(wizard).some((line) => line.includes("writer")));
  assert.ok(!lines(wizard).some((line) => line.includes("research")));

  // Select the writer agent.
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("select model")));
  assert.ok(lines(wizard).some((line) => line.includes("openai/gpt-5")));

  // Select the model.
  wizard.handleInput("\r");
  await flush();
  assert.ok(lines(wizard).some((line) => line.includes("thinking level")));

  // Select the thinking level.
  wizard.handleInput("\r");
  await flush();
  assert.ok(lines(wizard).some((line) => line.includes("Agent model set.")));
  wizard.handleInput("\r");
  const settled = await result.promise;
  assert.deepEqual(settled, { status: "saved", message: "Agent model set." });
});

test("remove flow skips the model step and calls removeModel", async () => {
  let removed: string | undefined;
  const ctl = controller({
    removeModel: async (name) => {
      removed = name;
      return { ok: true, message: "Agent model removed." };
    },
  });
  const result = resultPromise();
  const wizard = new ManageAgentModelWizard({ tui: tui(), theme, controller: ctl, done: result.resolve });
  await flush();

  // Move to "Remove agent model".
  wizard.handleInput("\x1b[B"); // down
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("select agent")));

  wizard.handleInput("\r"); // select first agent
  await flush();
  assert.equal(removed, "research");
  assert.ok(lines(wizard).some((line) => line.includes("Agent model removed.")));
  wizard.handleInput("\r");
  assert.deepEqual(await result.promise, { status: "saved", message: "Agent model removed." });
});

test("filtering models narrows the list", async () => {
  const ctl = controller();
  const wizard = new ManageAgentModelWizard({ tui: tui(), theme, controller: ctl, done: () => {} });
  await flush();
  wizard.handleInput("\r"); // action: set
  wizard.handleInput("\r"); // first agent
  for (const char of "openai") wizard.handleInput(char);
  assert.ok(lines(wizard).some((line) => line.includes("openai/gpt-5")));
  assert.ok(!lines(wizard).some((line) => line.includes("anthropic/claude-sonnet-4-5")));
});

test("escape returns from agent step to the action menu", async () => {
  const ctl = controller();
  const wizard = new ManageAgentModelWizard({ tui: tui(), theme, controller: ctl, done: () => {} });
  await flush();
  wizard.handleInput("\r"); // action: set
  assert.ok(lines(wizard).some((line) => line.includes("select agent")));
  wizard.handleInput("\x1b"); // escape
  assert.ok(lines(wizard).some((line) => line.includes("Set / replace agent model")));
});

test("empty agent list reports an error result", async () => {
  const ctl = controller({ listAgents: async () => [] });
  const wizard = new ManageAgentModelWizard({ tui: tui(), theme, controller: ctl, done: () => {} });
  await flush();
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("No agents are defined")));
});
