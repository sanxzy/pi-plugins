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
    getGlobalModel: async () => ({ model: undefined, thinking: undefined, configPath: "/tmp/config.json" }),
    setGlobalModel: async (reference, thinking) => ({ ok: true, message: `Global agent model set to ${reference}${thinking ? `, thinking ${thinking}` : ""}.` }),
    removeGlobalModel: async () => ({ ok: true, message: "Global agent model removed." }),
    cancel: async () => {
      await undefined;
    },
    listGroups: async () => [],
    activateGroup: async () => ({ ok: true, message: "Activated." }),
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

test("the action menu shows the current global model and thinking", async () => {
  const ctl = controller({ getGlobalModel: async () => ({ model: "commandcode/meta/muse-spark-1.2-contributor", thinking: "high", configPath: "/home/user/.pi/agent/pi-c2/config.json" }) });
  const wizard = new ManageAgentModelWizard({ tui: tui(), theme, controller: ctl, done: () => {} });
  await flush();
  assert.ok(lines(wizard).some((line) => line.includes("Global agent model:")));
  assert.ok(lines(wizard).some((line) => line.includes("commandcode/meta/muse-spark-1.2-contributor")));
  assert.ok(lines(wizard).some((line) => line.includes("thinking high")));
});

test("global set flow goes action → global → model → thinking → result and calls setGlobalModel with thinking", async () => {
  let setReference: string | undefined;
  let setThinking: string | undefined;
  const ctl = controller({
    setGlobalModel: async (reference, thinking) => {
      setReference = reference;
      setThinking = thinking;
      return { ok: true, message: `Global agent model set to ${reference}${thinking ? `, thinking ${thinking}` : ""}.` };
    },
  });
  const result = resultPromise();
  const wizard = new ManageAgentModelWizard({ tui: tui(), theme, controller: ctl, done: result.resolve });
  await flush();

  // Action menu: move to "Set / replace global agent model" (index 2).
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("global agent model")));

  // Global step: select "Set / replace global agent model".
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("select model")));

  // Model step: select the first model (reasoning-capable → thinking step).
  wizard.handleInput("\r");
  await flush();
  assert.ok(lines(wizard).some((line) => line.includes("thinking level")));

  // Thinking step: select the first level ("off").
  wizard.handleInput("\r");
  await flush();
  assert.equal(setReference, "anthropic/claude-sonnet-4-5");
  assert.equal(setThinking, "off");
  const rendered = lines(wizard).join(" ").replace(/\s+/g, " ");
  assert.ok(rendered.includes("Global agent model set to anthropic/claude-sonnet-4-5, thinking off."), `rendered: ${rendered}`);
  wizard.handleInput("\r");
  assert.deepEqual(await result.promise, { status: "saved", message: "Global agent model set to anthropic/claude-sonnet-4-5, thinking off." });
});

test("global set flow skips the thinking step for non-reasoning models", async () => {
  let setReference: string | undefined;
  const ctl = controller({
    listThinkingLevels: async () => [{ level: "off", label: "off" }],
    setGlobalModel: async (reference) => {
      setReference = reference;
      return { ok: true, message: `Global agent model set to ${reference}.` };
    },
  });
  const result = resultPromise();
  const wizard = new ManageAgentModelWizard({ tui: tui(), theme, controller: ctl, done: result.resolve });
  await flush();

  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\r");
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("select model")));
  wizard.handleInput("\r");
  await flush();
  assert.equal(setReference, "anthropic/claude-sonnet-4-5");
  assert.ok(lines(wizard).some((line) => line.includes("Global agent model set to anthropic/claude-sonnet-4-5.")));
  wizard.handleInput("\r");
  assert.deepEqual(await result.promise, { status: "saved", message: "Global agent model set to anthropic/claude-sonnet-4-5." });
});

test("global remove flow calls removeGlobalModel", async () => {
  let removed = false;
  const ctl = controller({
    removeGlobalModel: async () => {
      removed = true;
      return { ok: true, message: "Global agent model removed." };
    },
  });
  const result = resultPromise();
  const wizard = new ManageAgentModelWizard({ tui: tui(), theme, controller: ctl, done: result.resolve });
  await flush();

  // Action menu: move to "Remove global agent model" (index 3).
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("global agent model")));

  // Global step: select "Remove global agent model".
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\r");
  await flush();
  assert.equal(removed, true);
  assert.ok(lines(wizard).some((line) => line.includes("Global agent model removed.")));
  wizard.handleInput("\r");
  assert.deepEqual(await result.promise, { status: "saved", message: "Global agent model removed." });
});

test("global step back returns to the action menu", async () => {
  const ctl = controller();
  const wizard = new ManageAgentModelWizard({ tui: tui(), theme, controller: ctl, done: () => {} });
  await flush();
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("global agent model")));
  wizard.handleInput("\x1b"); // escape → back to action
  assert.ok(lines(wizard).some((line) => line.includes("Set / replace agent model")));
});

test("the action menu shows the active model group and activation calls activateGroup", async () => {
  let activated: string | undefined;
  const ctl = controller({
    listGroups: async () => [
      { id: "work", name: "Work", mode: "fallback", models: [{ ref: "openai/gpt-5" }], active: true },
      { id: "side", name: "Side", mode: "round-robin", models: [{ ref: "openai/gpt-5" }], active: false },
    ],
    activateGroup: async (id) => {
      activated = id;
      return { ok: true, message: `Active model group set to "${id}".` };
    },
  });
  const result = resultPromise();
  const wizard = new ManageAgentModelWizard({ tui: tui(), theme, controller: ctl, done: result.resolve });
  await flush();
  assert.ok(lines(wizard).some((line) => line.includes("Active model group: Work")));
  assert.ok(lines(wizard).some((line) => line.includes("5. Activate model group")));

  // Action menu: move to "Activate model group" (index 4).
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("activate model group")));
  assert.ok(lines(wizard).some((line) => line.includes("1. Work [fallback] ●")));

  // Move down to "Side" and activate it.
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\r");
  await flush();
  assert.equal(activated, "side");
  assert.ok(lines(wizard).some((line) => line.includes("Active model group set to \"side\".")));
});

test("escape from the group picker returns to the action menu", async () => {
  const ctl = controller({ listGroups: async () => [{ id: "work", name: "Work", mode: "fallback", models: [{ ref: "openai/gpt-5" }], active: false }] });
  const wizard = new ManageAgentModelWizard({ tui: tui(), theme, controller: ctl, done: () => {} });
  await flush();
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("activate model group")));
  wizard.handleInput("\x1b");
  assert.ok(lines(wizard).some((line) => line.includes("Manage agent model")));
});
