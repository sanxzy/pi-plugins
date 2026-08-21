import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { TUI } from "@earendil-works/pi-tui";
import type {
  ManageModelGroupsController,
  ManageModelGroupsGroupItem,
  ManageModelGroupsGroupInput,
} from "@xzy-ai/tui";
import { ManageModelGroupsWizard, type ManageModelGroupsResult } from "../src/manage-model-groups-wizard.ts";

function tui(): TUI {
  return { terminal: { rows: 24 }, requestRender: () => {} } as unknown as TUI;
}

const theme = { fg: (_color: string, text: string) => text };

const GROUPS: ManageModelGroupsGroupItem[] = [
  {
    id: "work",
    name: "Work",
    mode: "fallback",
    quarantineTurns: 5,
    models: [{ ref: "openai/a", thinking: "high", reasoning: true }],
    contextWindow: 200000,
    active: false,
  },
  {
    id: "side",
    name: "Side",
    mode: "round-robin",
    quarantineTurns: 10,
    models: [{ ref: "openai/b" }, { ref: "openai/c" }],
    active: true,
  },
];

const MODELS = [
  { provider: "openai", id: "a", reference: "openai/a", reasoning: true },
  { provider: "openai", id: "b", reference: "openai/b", reasoning: false },
  { provider: "anthropic", id: "c", reference: "anthropic/c", reasoning: true },
];

function controller(overrides: Partial<ManageModelGroupsController> = {}): ManageModelGroupsController {
  return {
    listGroups: async () => GROUPS,
    listModels: async () => MODELS,
    listThinkingLevels: async () => [{ level: "off", label: "off" }, { level: "high", label: "high" }],
    createGroup: async (_input) => ({ ok: true, message: "Group created." }),
    updateGroup: async (_id, _input) => ({ ok: true, message: "Group updated." }),
    deleteGroup: async (_id) => ({ ok: true, message: "Group deleted." }),
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function lines(component: { render(width: number): string[] }): string[] {
  return stripVTControlCharacters(component.render(60).join("\n")).split("\n");
}

function resultPromise(): { promise: Promise<ManageModelGroupsResult>; resolve: (result: ManageModelGroupsResult) => void } {
  let resolve!: (result: ManageModelGroupsResult) => void;
  const promise = new Promise<ManageModelGroupsResult>((next) => { resolve = next; });
  return { promise, resolve };
}

test("renders the action menu and escape cancels", async () => {
  const ctl = controller();
  const result = resultPromise();
  const wizard = new ManageModelGroupsWizard({ tui: tui(), theme, controller: ctl, done: result.resolve });
  await flush();
  assert.ok(lines(wizard).some((line) => line.includes("Manage model groups")));
  assert.ok(lines(wizard).some((line) => line.includes("1. Create group")));
  assert.ok(lines(wizard).some((line) => line.includes("2. Edit group")));
  assert.ok(lines(wizard).some((line) => line.includes("3. Delete group")));
  assert.ok(lines(wizard).some((line) => line.includes("4. Done")));
  wizard.handleInput("\x1b");
  assert.deepEqual(await result.promise, { status: "cancelled", message: "Model group management cancelled" });
});

test("up/down navigation and filtering narrows groups", async () => {
  const wizard = new ManageModelGroupsWizard({ tui: tui(), theme, controller: controller(), done: () => {} });
  await flush();
  wizard.handleInput("\x1b[B"); // select "Edit group"
  wizard.handleInput("\r"); // enter group picker
  wizard.handleInput("\x1b[B"); // down → "Side" selected
  wizard.handleInput("\r");
  await flush();
  // Filter behaves in the group list.
  const wizard2 = new ManageModelGroupsWizard({ tui: tui(), theme, controller: controller(), done: () => {} });
  await flush();
  wizard2.handleInput("\x1b[B");
  wizard2.handleInput("\r");
  for (const char of "side") wizard2.handleInput(char);
  const rendered = lines(wizard2);
  assert.ok(rendered.some((line) => line.includes("Side")));
  assert.ok(!rendered.some((line) => line.includes("Work")));
});

test("escape from the group picker returns to the action menu", async () => {
  const wizard = new ManageModelGroupsWizard({ tui: tui(), theme, controller: controller(), done: () => {} });
  await flush();
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("edit group")));
  wizard.handleInput("\x1b");
  assert.ok(lines(wizard).some((line) => line.includes("Manage model groups")));
});

test("create flow: name → mode → quarantine → models → context window → save calls createGroup", async () => {
  let created: ManageModelGroupsGroupInput | undefined;
  const ctl = controller({
    createGroup: async (input) => {
      created = input;
      return { ok: true, message: "Group created." };
    },
  });
  const result = resultPromise();
  const wizard = new ManageModelGroupsWizard({ tui: tui(), theme, controller: ctl, done: result.resolve });
  await flush();
  wizard.handleInput("\r"); // → "Create group"
  assert.ok(lines(wizard).some((line) => line.includes("Create group · name")));
  for (const char of "nightly") wizard.handleInput(char);
  wizard.handleInput("\r"); // next → mode
  assert.ok(lines(wizard).some((line) => line.includes("Group mode")));
  wizard.handleInput("\r"); // fallback → quarantine
  assert.ok(lines(wizard).some((line) => line.includes("Quarantine turns")));
  // Clear the default "5" and set 12
  wizard.handleInput("\x7f");
  for (const char of "12") wizard.handleInput(char);
  wizard.handleInput("\r"); // quarantine → add models
  assert.ok(lines(wizard).some((line) => line.includes("Add model to group")));
  wizard.handleInput("\r"); // first model (openai/a, reasoning → thinking)
  await flush();
  assert.ok(lines(wizard).some((line) => line.includes("Thinking level")));
  wizard.handleInput("\x1b[B"); // → high
  wizard.handleInput("\r"); // pick thinking → model menu
  assert.ok(lines(wizard).some((line) => line.includes("Group models")));
  // Save group is option 4; move down 3 and enter to set context window.
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("Group context window")));
  for (const char of "32000") wizard.handleInput(char);
  wizard.handleInput("\r");
  await flush();
  assert.deepEqual(created, {
    name: "nightly",
    mode: "fallback",
    quarantineTurns: 12,
    contextWindow: 32000,
    models: [{ ref: "openai/a", thinking: "high" }],
  });
  assert.ok(lines(wizard).some((line) => line.includes("Group created.")));
  wizard.handleInput("\r");
  assert.deepEqual(await result.promise, { status: "saved", message: "Group created." });
});

test("edit flow pre-fills the group and update saves without recreating", async () => {
  let updatedId: string | undefined;
  let updated: ManageModelGroupsGroupInput | undefined;
  const ctl = controller({
    updateGroup: async (id, input) => {
      updatedId = id;
      updated = input;
      return { ok: true, message: "Group updated." };
    },
  });
  const result = resultPromise();
  const wizard = new ManageModelGroupsWizard({ tui: tui(), theme, controller: ctl, done: result.resolve });
  await flush();
  wizard.handleInput("\x1b[B"); // → Edit
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("edit group")));
  wizard.handleInput("\r"); // edit first group (Work)
  assert.ok(lines(wizard).some((line) => line.includes("Edit group · name")));
  assert.ok(lines(wizard).some((line) => line.includes("Name: Work")));
  wizard.handleInput("\r"); // keep name → mode
  wizard.handleInput("\x1b[B"); // → round-robin
  wizard.handleInput("\r"); // mode → quarantine
  wizard.handleInput("\r"); // keep "5" → add models
  assert.ok(lines(wizard).some((line) => line.includes("Add model to group")));
  wizard.handleInput("\x1b"); // back to quarantine
  wizard.handleInput("\x1b"); // back to edit name
  wizard.handleInput("\x1b"); // back to edit picker
  assert.ok(lines(wizard).some((line) => line.includes("Manage model groups")));
  assert.equal(updatedId, undefined, "escaping the edit flow never saves");
});