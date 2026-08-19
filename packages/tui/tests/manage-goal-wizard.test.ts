import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { TUI } from "@earendil-works/pi-tui";
import { ManageGoalWizard, formatGoalInterval, type ManageGoalController, type ManageGoalItem, type ManageGoalResult } from "../src/manage-goal-wizard.ts";

function tui(): TUI {
  return { terminal: { rows: 24 }, requestRender: () => {} } as unknown as TUI;
}

const theme = { fg: (_color: string, text: string) => text };

const GOAL: ManageGoalItem = {
  goalId: "g-1",
  rootSessionId: "root",
  cwd: "/project",
  prompt: "Ship the plugin",
  intervalMs: 600_000,
  status: "active",
  createdAt: 1_000,
  updatedAt: 1_000,
};

function controller(overrides: Partial<ManageGoalController> = {}): ManageGoalController {
  return {
    get: async () => GOAL,
    create: async ({ prompt, interval }) => ({ ok: true, message: `Goal created: ${prompt} every ${interval || "10m"}.` }),
    pause: async () => ({ ok: true, message: "Goal paused." }),
    resume: async () => ({ ok: true, message: "Goal resumed." }),
    clear: async () => ({ ok: true, message: "Goal cleared." }),
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

function resultPromise(): { promise: Promise<ManageGoalResult>; resolve: (result: ManageGoalResult) => void } {
  let resolve!: (result: ManageGoalResult) => void;
  const promise = new Promise<ManageGoalResult>((next) => { resolve = next; });
  return { promise, resolve };
}

test("formatGoalInterval renders compact human durations", () => {
  assert.equal(formatGoalInterval(0), "0ms");
  assert.equal(formatGoalInterval(30_000), "30s");
  assert.equal(formatGoalInterval(600_000), "10m");
  assert.equal(formatGoalInterval(3_600_000), "1h");
  assert.equal(formatGoalInterval(5_703_000), "1h 35m 3s");
  assert.equal(formatGoalInterval(90_000_000), "1d 1h");
});

test("menu shows the current goal and its status", async () => {
  const wizard = new ManageGoalWizard({ tui: tui(), theme, controller: controller(), done: () => {} });
  await flush();
  const rendered = lines(wizard).join("\n");
  assert.match(rendered, /Manage goal/);
  assert.match(rendered, /Status: active/);
  assert.match(rendered, /Prompt: Ship the plugin/);
  assert.match(rendered, /Interval: 10m/);
  assert.match(rendered, /Pause goal/);
  assert.match(rendered, /Replace goal/);
  assert.match(rendered, /Clear goal/);
});

test("menu with no goal offers create and shows a hint", async () => {
  const wizard = new ManageGoalWizard({ tui: tui(), theme, controller: controller({ get: async () => undefined }), done: () => {} });
  await flush();
  const rendered = lines(wizard).join("\n");
  assert.match(rendered, /No goal is set for this session\./);
  assert.match(rendered, /Create goal/);
  assert.doesNotMatch(rendered, /Pause goal/);
});

test("create flow collects prompt and interval then calls create with replacement", async () => {
  let created: { prompt: string; interval: string } | undefined;
  const ctl = controller({
    create: async (input) => {
      created = input;
      return { ok: true, message: `Goal created: ${input.prompt} every ${input.interval || "10m"}.` };
    },
  });
  const result = resultPromise();
  const wizard = new ManageGoalWizard({ tui: tui(), theme, controller: ctl, done: result.resolve });
  await flush();

  // Menu: move to "Replace goal" (index 1) when a goal exists.
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("goal prompt")));

  // Type the prompt and submit.
  for (const char of "Build the thing") wizard.handleInput(char);
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("Interval")));

  // Type the interval and submit.
  for (const char of "2h") wizard.handleInput(char);
  wizard.handleInput("\r");
  await flush();
  assert.equal(created?.prompt, "Build the thing");
  assert.equal(created?.interval, "2h");
  assert.ok(lines(wizard).some((line) => line.includes("Goal created: Build the thing every 2h.")));
  wizard.handleInput("\r");
  assert.deepEqual(await result.promise, { status: "saved", message: "Goal created: Build the thing every 2h." });
});

test("create flow with an empty interval uses the default", async () => {
  let created: { prompt: string; interval: string } | undefined;
  const ctl = controller({
    get: async () => undefined,
    create: async (input) => {
      created = input;
      return { ok: true, message: "Goal created." };
    },
  });
  const wizard = new ManageGoalWizard({ tui: tui(), theme, controller: ctl, done: () => {} });
  await flush();
  wizard.handleInput("\r"); // Create goal
  for (const char of "Ship it") wizard.handleInput(char);
  wizard.handleInput("\r");
  wizard.handleInput("\r"); // empty interval
  await flush();
  assert.equal(created?.prompt, "Ship it");
  assert.equal(created?.interval, "");
});

test("pause flow collects a reason and calls pause", async () => {
  let reason: string | undefined;
  const ctl = controller({
    pause: async (r) => {
      reason = r;
      return { ok: true, message: "Goal paused." };
    },
  });
  const result = resultPromise();
  const wizard = new ManageGoalWizard({ tui: tui(), theme, controller: ctl, done: result.resolve });
  await flush();

  wizard.handleInput("\r"); // Pause goal (index 0 for active)
  assert.ok(lines(wizard).some((line) => line.includes("pause reason")));
  for (const char of "waiting for review") wizard.handleInput(char);
  wizard.handleInput("\r");
  await flush();
  assert.equal(reason, "waiting for review");
  assert.ok(lines(wizard).some((line) => line.includes("Goal paused.")));
  wizard.handleInput("\r");
  assert.deepEqual(await result.promise, { status: "saved", message: "Goal paused." });
});

test("resume flow calls resume for a paused goal", async () => {
  let resumed = false;
  const ctl = controller({
    get: async () => ({ ...GOAL, status: "paused" as const, pauseReason: "blocked" }),
    resume: async () => {
      resumed = true;
      return { ok: true, message: "Goal resumed." };
    },
  });
  const result = resultPromise();
  const wizard = new ManageGoalWizard({ tui: tui(), theme, controller: ctl, done: result.resolve });
  await flush();
  assert.ok(lines(wizard).some((line) => line.includes("Resume goal")));
  wizard.handleInput("\r");
  await flush();
  assert.equal(resumed, true);
  assert.ok(lines(wizard).some((line) => line.includes("Goal resumed.")));
  wizard.handleInput("\r");
  assert.deepEqual(await result.promise, { status: "saved", message: "Goal resumed." });
});

test("clear flow asks for confirmation before clearing", async () => {
  let cleared = false;
  const ctl = controller({
    clear: async () => {
      cleared = true;
      return { ok: true, message: "Goal cleared." };
    },
  });
  const result = resultPromise();
  const wizard = new ManageGoalWizard({ tui: tui(), theme, controller: ctl, done: result.resolve });
  await flush();

  // Active goal: Pause / Replace / Clear / Done → move to Clear (index 2).
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("Clear the current goal")));
  wizard.handleInput("\r"); // confirm Clear
  await flush();
  assert.equal(cleared, true);
  assert.ok(lines(wizard).some((line) => line.includes("Goal cleared.")));
  wizard.handleInput("\r");
  assert.deepEqual(await result.promise, { status: "saved", message: "Goal cleared." });
});

test("clear confirmation can be cancelled", async () => {
  let cleared = false;
  const ctl = controller({
    clear: async () => {
      cleared = true;
      return { ok: true, message: "Goal cleared." };
    },
  });
  const wizard = new ManageGoalWizard({ tui: tui(), theme, controller: ctl, done: () => {} });
  await flush();

  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\r");
  wizard.handleInput("\x1b[B"); // move to Cancel
  wizard.handleInput("\r");
  assert.equal(cleared, false);
  assert.ok(lines(wizard).some((line) => line.includes("Manage goal")));
});

test("escape from a prompt returns to the menu", async () => {
  const wizard = new ManageGoalWizard({ tui: tui(), theme, controller: controller(), done: () => {} });
  await flush();
  wizard.handleInput("\x1b[B"); // Replace goal
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("goal prompt")));
  wizard.handleInput("\x1b"); // escape
  assert.ok(lines(wizard).some((line) => line.includes("Manage goal")));
});

test("a failed mutation shows an error and keeps the wizard open", async () => {
  const ctl = controller({
    create: async () => ({ ok: false, message: "prompt must contain non-whitespace text" }),
  });
  const wizard = new ManageGoalWizard({ tui: tui(), theme, controller: ctl, done: () => {} });
  await flush();
  wizard.handleInput("\x1b[B"); // Replace
  wizard.handleInput("\r");
  wizard.handleInput("\r"); // empty prompt
  wizard.handleInput("\r"); // empty interval
  await flush();
  assert.ok(lines(wizard).some((line) => line.includes("prompt must contain non-whitespace text")));
});

test("escape on the menu cancels with a cancelled result", async () => {
  const result = resultPromise();
  const wizard = new ManageGoalWizard({ tui: tui(), theme, controller: controller(), done: result.resolve });
  await flush();
  wizard.handleInput("\x1b");
  assert.deepEqual(await result.promise, { status: "cancelled" });
});

test("create flow preserves large pasted prompt content instead of keeping the paste marker", async () => {
  // Simulate a large paste (> 10 lines) which the TUI Editor replaces with a
  // paste marker like `[paste #1 +11 lines]`. The wizard must expand that
  // marker back to the original content before submitting.
  const largePrompt = Array.from({ length: 11 }, (_, i) => `Line ${i + 1} of my very long goal prompt`).join("\n");
  let created: { prompt: string; interval: string } | undefined;
  const ctl = controller({
    get: async () => undefined,
    create: async (input) => {
      created = input;
      return { ok: true, message: "Goal created." };
    },
  });
  const wizard = new ManageGoalWizard({ tui: tui(), theme, controller: ctl, done: () => {} });
  await flush();

  // Navigate to Create goal and start the prompt step.
  wizard.handleInput("\r"); // Create goal
  assert.ok(lines(wizard).some((line) => line.includes("goal prompt")));

  // Simulate a bracketed paste of a large (> 10 lines) text block. The Editor
  // detects large pastes and replaces them with a marker like
  // `[paste #1 +11 lines]` while storing the original content internally.
  // Bracketed paste format: ESC [ 200 ~ <content> ESC [ 201 ~
  wizard.handleInput("\x1b[200~" + largePrompt + "\x1b[201~");

  wizard.handleInput("\r"); // submit prompt
  assert.ok(lines(wizard).some((line) => line.includes("Interval")));

  wizard.handleInput("\r"); // empty interval
  await flush();

  // The full large prompt must be preserved, not the marker.
  assert.equal(created?.prompt, largePrompt);
});

test("pause flow preserves large pasted reason content instead of keeping the paste marker", async () => {
  const largeReason = Array.from({ length: 12 }, (_, i) => `Reason line ${i + 1} explaining the detailed blocker`).join("\n");
  let reason: string | undefined;
  const ctl = controller({
    pause: async (r) => {
      reason = r;
      return { ok: true, message: "Goal paused." };
    },
  });
  const wizard = new ManageGoalWizard({ tui: tui(), theme, controller: ctl, done: () => {} });
  await flush();

  wizard.handleInput("\r"); // Pause goal
  assert.ok(lines(wizard).some((line) => line.includes("pause reason")));

  // Simulate a bracketed paste of a large (> 10 lines) reason.
  wizard.handleInput("\x1b[200~" + largeReason + "\x1b[201~");

  wizard.handleInput("\r"); // submit reason
  await flush();

  assert.equal(reason, largeReason);
});
