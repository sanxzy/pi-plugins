import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import { AgentFooter, type AgentFooterInfo, type FooterTreeRow } from "../src/agent-footer.ts";
import { AgentLiveManager, type AgentLiveSession } from "../src/agent-manager-live.ts";
import { textTheme } from "./test-theme.ts";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ESC = "\x1b";
const ENTER = "\r";
const ALT_X = "\x1bx";

function fakeTUI(rows = 24): TUI {
  return { terminal: { rows }, requestRender: () => {} } as unknown as TUI;
}

function info(): AgentFooterInfo {
  return {
    cwd: "/Users/test/work",
    home: "/Users/test",
    branch: "main",
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextPercent: 0,
    contextWindow: 200_000,
    autoCompactEnabled: true,
    model: "m",
    providerCount: 1,
    reasoning: false,
  };
}

function row(rowId: string, overrides: Partial<FooterTreeRow> = {}): FooterTreeRow {
  return {
    rowId,
    root: rowId === "main",
    status: "active",
    depth: 0,
    description: rowId,
    durationMs: 0,
    enterable: false,
    ...overrides,
  };
}

function runnable(): FooterTreeRow {
  return {
    rowId: "job-a",
    status: "running",
    depth: 1,
    description: "Implement feature",
    durationMs: 1_000,
    enterable: true,
  };
}

function runningLive(steers: string[] = [], onUnsubscribe?: () => void): AgentLiveSession {
  return {
    snapshot: {
      status: "running",
      settled: false,
      transcript: [
        { id: "m1", kind: "message", role: "assistant", text: "working...", complete: false },
      ],
    },
    subscribe: (_listener: () => void) => () => onUnsubscribe?.(),
    steer: async (prompt: string) => {
      steers.push(prompt);
    },
  };
}

function render(component: { render(width: number): string[] }, width = 100): string[] {
  return component.render(width).map(stripVTControlCharacters);
}

test("Enter on an enterable running child invokes onEnter with the selected row", () => {
  let opened: FooterTreeRow | undefined;
  const footer = new AgentFooter({
    tui: fakeTUI(),
    theme: textTheme,
    getInfo: info,
    getRows: () => [row("main"), runnable()],
    onEnter: (selected) => {
      opened = selected;
    },
  });
  footer.handleInput(DOWN);
  footer.handleInput(DOWN);
  footer.handleInput(ENTER);
  assert.equal(opened?.rowId, "job-a", "Enter opens the selected enterable child");
});

test("Enter on a non-enterable row shows a non-actionable hint and stays in management mode", () => {
  let opened = 0;
  const footer = new AgentFooter({
    tui: fakeTUI(),
    theme: textTheme,
    getInfo: info,
    getRows: () => [
      row("main"),
      row("queued-job", { status: "queued", depth: 1, enterable: false }),
      row("done-job", { status: "completed", depth: 1, enterable: false }),
    ],
    onEnter: () => {
      opened++;
    },
  });
  footer.handleInput(DOWN);
  footer.handleInput(DOWN);
  footer.handleInput(ENTER);
  assert.equal(opened, 0, "non-actionable rows never invoke onEnter");
  assert.match(render(footer).join("\n"), /not enterable/i, "a clear non-actionable hint is shown");
  assert.match(render(footer).join("\n"), /❯/, "management mode stays active");
  footer.handleInput(UP);
  assert.doesNotMatch(render(footer).join("\n"), /not enterable/i, "navigation clears the hint");
});

test("typed prompts accumulate in a draft and steer only on Enter", async () => {
  const steers: string[] = [];
  const view = new AgentLiveManager({
    tui: fakeTUI(),
    theme: textTheme,
    live: runningLive(steers),
    done: () => {},
  });
  view.handleInput("h");
  view.handleInput("i");
  view.handleInput(ENTER);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(steers, ["hi"], "the draft steers once as a whole line");
});

test("Alt+x shows a confirmation dialog and confirmed cancellation aborts the child", async () => {
  let aborted = 0;
  let confirmed = 0;
  const view = new AgentLiveManager({
    tui: fakeTUI(),
    theme: textTheme,
    live: runningLive(),
    abort: async () => {
      aborted++;
    },
    confirm: async () => {
      confirmed++;
      return true;
    },
    done: () => {},
  });
  view.handleInput(ALT_X);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(confirmed, 1, "Alt+x asks for confirmation");
  assert.equal(aborted, 1, "confirmed cancellation aborts the child");
});

test("declining the confirmation never aborts the child", async () => {
  let aborted = 0;
  const view = new AgentLiveManager({
    tui: fakeTUI(),
    theme: textTheme,
    live: runningLive(),
    abort: async () => {
      aborted++;
    },
    confirm: async () => false,
    done: () => {},
  });
  view.handleInput(ALT_X);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aborted, 0, "a declined confirmation never aborts");
});

test("closing or disposing the live view never aborts a running child", () => {
  let aborted = 0;
  let unsubscribed = 0;
  const view = new AgentLiveManager({
    tui: fakeTUI(),
    theme: textTheme,
    live: runningLive([], () => {
      unsubscribed++;
    }),
    abort: async () => {
      aborted++;
    },
    confirm: async () => true,
    done: () => {},
  });
  view.handleInput(ESC);
  view.dispose();
  view.dispose();
  assert.equal(aborted, 0, "escape and dispose never abort the child");
  assert.equal(unsubscribed, 1, "dispose releases the subscription exactly once");
});

test("a settled live view is read-only and ignores steering and cancellation", async () => {
  const steers: string[] = [];
  let aborted = 0;
  const view = new AgentLiveManager({
    tui: fakeTUI(),
    theme: textTheme,
    live: {
      snapshot: {
        status: "failed",
        settled: true,
        transcript: [
          { id: "m1", kind: "message", role: "assistant", text: "failed", complete: true },
        ],
      },
      subscribe: () => () => {},
      steer: async (prompt: string) => {
        steers.push(prompt);
      },
    },
    abort: async () => {
      aborted++;
    },
    confirm: async () => true,
    done: () => {},
  });
  view.handleInput("x");
  view.handleInput(ENTER);
  view.handleInput(ALT_X);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(steers, [], "settled views accept no steering");
  assert.equal(aborted, 0, "settled views never abort");
  const output = render(view).join("\n");
  assert.match(output, /read-only/, "input is described as disabled");
  assert.match(output, /failed/, "terminal status and retained transcript remain visible");
});
