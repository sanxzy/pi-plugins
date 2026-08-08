import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import { AgentFooter, type AgentFooterInfo, type FooterTreeRow } from "../src/agent-footer.ts";
import { AgentLiveManager, type AgentLiveManagerTheme, type AgentLiveSession } from "../src/agent-manager-live.ts";
import { textTheme } from "./test-theme.ts";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const HOME = "\x1b[H";
const END = "\x1b[F";
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

/** Tagging theme: colors every call as `[color]text[/color]` for assertions. */
function tagTheme(): AgentLiveManagerTheme {
  return { fg: (color, text) => `[${color}]${text}[/${color}]` };
}

function settledLive(status: AgentLiveSession["snapshot"]["status"], transcript: AgentLiveSession["snapshot"]["transcript"] = []): AgentLiveSession {
  return {
    snapshot: { status, settled: true, transcript },
    subscribe: () => () => {},
    steer: async () => {},
  };
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

function longLive(count: number): AgentLiveSession {
  return {
    snapshot: {
      status: "running",
      settled: false,
      transcript: Array.from({ length: count }, (_, index) => ({
        id: `m${index}`,
        kind: "message" as const,
        role: "assistant" as const,
        text: `message line ${index}`,
        complete: true,
      })),
    },
    subscribe: () => () => {},
    steer: async () => {},
  };
}

test("a long transcript starts at the tail and scrolls to earlier lines while keeping chrome", () => {
  const view = new AgentLiveManager({
    tui: fakeTUI(12),
    theme: textTheme,
    live: longLive(30),
    done: () => {},
  });
  let output = render(view).join("\n");
  assert.match(output, /message line 29/, "tail message is visible by default");
  assert.doesNotMatch(output, /message line 0/, "oldest message is off-screen initially");
  assert.match(output, /╭/, "top border chrome remains");
  assert.match(output, /╰/, "bottom border chrome remains");

  view.handleInput(END);
  output = render(view).join("\n");
  assert.match(output, /message line 0/, "End reveals the oldest message");
  assert.doesNotMatch(output, /message line 29/, "tail is off-screen at the top");

  view.handleInput(HOME);
  output = render(view).join("\n");
  assert.match(output, /message line 29/, "Home returns to the tail");

  view.handleInput(END);
  view.handleInput(PAGE_DOWN);
  output = render(view).join("\n");
  assert.doesNotMatch(output, /message line 0/, "PageDown moves off the very top");
  view.handleInput(PAGE_UP);
  output = render(view).join("\n");
  assert.match(output, /message line 0/, "PageUp returns toward the oldest message");
});

test("Up/Down scroll line by line and scroll indicator appears only when away from the tail", () => {
  const view = new AgentLiveManager({
    tui: fakeTUI(10),
    theme: textTheme,
    live: longLive(20),
    done: () => {},
  });
  let output = render(view).join("\n");
  assert.doesNotMatch(output, /↑ scroll/, "no scroll indicator at the tail");

  view.handleInput(END);
  output = render(view).join("\n");
  assert.match(output, /↑ scroll/, "scroll indicator appears while scrolled");

  view.handleInput(UP);
  output = render(view).join("\n");
  assert.match(output, /message line 0/, "Up reveals an earlier line");
  view.handleInput(DOWN);
  output = render(view).join("\n");
  assert.doesNotMatch(output, /message line 0/, "Down moves back toward the tail");
});

test("scrolling keys never enter the steering draft and steering still works after scrolling", async () => {
  const steers: string[] = [];
  const view = new AgentLiveManager({
    tui: fakeTUI(10),
    theme: textTheme,
    live: {
      snapshot: {
        status: "running",
        settled: false,
        transcript: Array.from({ length: 20 }, (_, index) => ({
          id: `m${index}`,
          kind: "message" as const,
          role: "assistant" as const,
          text: `message line ${index}`,
          complete: true,
        })),
      },
      subscribe: () => () => {},
      steer: async (prompt: string) => {
        steers.push(prompt);
      },
    },
    done: () => {},
  });
  view.handleInput(PAGE_UP);
  view.handleInput("h");
  view.handleInput("i");
  view.handleInput(ENTER);
  view.handleInput(PAGE_DOWN);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(steers, ["hi"], "scroll keys never enter the draft; typed text still steers");
});

test("long messages wrap across rows and tool args respect the content width", () => {
  const view = new AgentLiveManager({
    tui: fakeTUI(24),
    theme: textTheme,
    live: {
      snapshot: {
        status: "running",
        settled: false,
        transcript: [
          { id: "m1", kind: "message", role: "assistant", text: "a very long sentence that should wrap onto more than one display row to stay readable", complete: true },
          { id: "t1", kind: "tool", toolCallId: "call-1", toolName: "bash", args: { command: "printf 'x'.repeat(200)" }, text: "", complete: false },
        ],
      },
      subscribe: () => () => {},
      steer: async () => {},
    },
    done: () => {},
  });
  const lines = render(view, 40);
  for (const line of lines) assert.ok(line.length <= 40, `line fits within width: ${line}`);
  assert.ok(lines.length > 4, "wrapped message and tool args expand beyond a single row");
});

test("End reaches the oldest row at a narrow rendered overlay width", () => {
  const tui = fakeTUI(10);
  const view = new AgentLiveManager({
    tui,
    theme: textTheme,
    live: longLive(30),
    done: () => {},
  });
  render(view, 30);
  view.handleInput(END);
  const lines = render(view, 30);
  assert.match(lines.join("\n"), /message line 0/, "End reaches the oldest row at the rendered overlay width");
  assert.doesNotMatch(lines.join("\n"), /message line 29/, "the tail is off-screen at the oldest position");
  assert.match(lines.join("\n"), /╭/, "top border chrome remains");
  assert.match(lines.join("\n"), /╰/, "bottom border chrome remains");
});

test("very short heights keep chrome and height changes re-clamp the panel", () => {
  const tui = fakeTUI(5);
  const view = new AgentLiveManager({
    tui,
    theme: textTheme,
    live: longLive(30),
    done: () => {},
  });
  const lines = render(view, 30);
  assert.ok(lines.length <= 5, `short viewport stays bounded: ${lines.length}`);
  assert.match(lines.join("\n"), /╭/, "top border survives a short viewport");
  assert.match(lines.join("\n"), /╰/, "bottom border survives a short viewport");

  (tui.terminal as unknown as { rows: number }).rows = 12;
  const expanded = render(view, 30);
  assert.ok(expanded.length <= 12, `height changes re-clamp the rendered panel: ${expanded.length}`);
  assert.match(expanded.join("\n"), /message line 29/, "tail content re-lays out at the larger height");
});

test("a settled live view remains scrollable while ignoring steering and cancellation", async () => {
  const steers: string[] = [];
  const view = new AgentLiveManager({
    tui: fakeTUI(10),
    theme: textTheme,
    live: {
      snapshot: {
        status: "failed",
        settled: true,
        transcript: Array.from({ length: 20 }, (_, index) => ({
          id: `m${index}`,
          kind: "message" as const,
          role: "assistant" as const,
          text: `message line ${index}`,
          complete: true,
        })),
      },
      subscribe: () => () => {},
      steer: async (prompt: string) => {
        steers.push(prompt);
      },
    },
    abort: async () => {},
    confirm: async () => true,
    done: () => {},
  });
  view.handleInput(END);
  let output = render(view).join("\n");
  assert.match(output, /message line 0/, "settled transcript scrolls to its oldest line");
  assert.match(output, /read-only/, "settled view remains read-only");
  assert.match(output, /← back • Esc close/, "settled legend keeps its navigation actions");
  view.handleInput("x");
  view.handleInput(ENTER);
  view.handleInput(ALT_X);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(steers, [], "settled view ignores steering while scrolling remains available");
});

test("each terminal status has a semantic icon color and retains the event count", () => {
  const cases: readonly [AgentLiveSession["snapshot"]["status"], string, string][] = [
    ["running", "●", "accent"],
    ["completed", "✓", "success"],
    ["failed", "✗", "error"],
    ["cancelled", "■", "warning"],
    ["interrupted", "■", "warning"],
  ];
  for (const [status, icon, color] of cases) {
    const view = new AgentLiveManager({
      tui: fakeTUI(),
      theme: tagTheme(),
      live: settledLive(status, [{ id: "m1", kind: "message", role: "assistant", text: "done", complete: true }]),
      done: () => {},
    });
    const output = view.render(100).join("\n");
    assert.match(output, new RegExp(`\\[${color}\\]${icon} ${status}\\[/${color}\\]`), `${status} uses its semantic status color`);
    assert.match(output, new RegExp(`1 events`), `${status} keeps the event count`);
  }
});

test("empty running and settled states explain what the user can do", () => {
  const running = new AgentLiveManager({
    tui: fakeTUI(),
    theme: textTheme,
    live: {
      snapshot: { status: "running", settled: false, transcript: [] },
      subscribe: () => () => {},
      steer: async () => {},
    },
    done: () => {},
  });
  const runningOutput = render(running).join("\n");
  assert.match(runningOutput, /No activity yet/);
  assert.match(runningOutput, /waiting|steer/i, "running empty state gives an actionable next step");

  const settled = new AgentLiveManager({
    tui: fakeTUI(),
    theme: textTheme,
    live: settledLive("completed"),
    done: () => {},
  });
  const settledOutput = render(settled).join("\n");
  assert.match(settledOutput, /No activity recorded|No transcript/i);
  assert.match(settledOutput, /read-only|back|close/i, "settled empty state explains its read-only action");
});

test("the legend changes for tail, scrolled, settled, and transient states", async () => {
  const view = new AgentLiveManager({
    tui: fakeTUI(10),
    theme: textTheme,
    live: longLive(20),
    done: () => {},
  });
  let output = render(view).join("\n");
  assert.match(output, /Type to steer.*Enter send.*Alt\+x cancel/);
  view.handleInput(END);
  output = render(view).join("\n");
  assert.match(output, /scroll.*Home.*tail|scroll.*PageDown/i, "scrolled legend explains how to return to the tail");

  const failing = new AgentLiveManager({
    tui: fakeTUI(),
    theme: textTheme,
    live: {
      snapshot: { status: "running", settled: false, transcript: [] },
      subscribe: () => () => {},
      steer: async () => {
        throw new Error("no");
      },
    },
    done: () => {},
  });
  failing.handleInput("h");
  failing.handleInput(ENTER);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(render(failing).join("\n"), /Steer failed/);

  const settled = new AgentLiveManager({
    tui: fakeTUI(),
    theme: textTheme,
    live: settledLive("completed", [{ id: "m1", kind: "message", role: "assistant", text: "done", complete: true }]),
    done: () => {},
  });
  assert.match(render(settled).join("\n"), /read-only.*back.*close/i, "settled legend is contextual and non-mutating");
});

test("draft input shows a cursor and backspace edits without steering", () => {
  const view = new AgentLiveManager({
    tui: fakeTUI(),
    theme: textTheme,
    live: runningLive(),
    done: () => {},
  });
  view.handleInput("h");
  view.handleInput("i");
  assert.match(render(view).join("\n"), /steer> hi█/, "draft renders a visible cursor");
  view.handleInput("\x7f");
  assert.match(render(view).join("\n"), /steer> h█/, "backspace removes the last draft character");
});

test("Enter clears the draft synchronously, sends once, and blank Enter never steers", async () => {
  const steers: string[] = [];
  let resolveSteer: (() => void) | undefined;
  const view = new AgentLiveManager({
    tui: fakeTUI(),
    theme: textTheme,
    live: {
      ...runningLive(steers),
      steer: async (prompt: string) => {
        steers.push(prompt);
        await new Promise<void>((resolve) => {
          resolveSteer = resolve;
        });
      },
    },
    done: () => {},
  });
  view.handleInput("h");
  view.handleInput("i");
  view.handleInput(ENTER);
  assert.doesNotMatch(render(view).join("\n"), /steer> /, "draft clears before steer resolves");
  assert.deepEqual(steers, ["hi"], "the prompt sends once");
  view.handleInput(ENTER);
  resolveSteer?.();
  await new Promise((resolve) => setImmediate(resolve));
  const blanks: string[] = [];
  const blankView = new AgentLiveManager({
    tui: fakeTUI(),
    theme: textTheme,
    live: runningLive(blanks),
    done: () => {},
  });
  blankView.handleInput(ENTER);
  blankView.handleInput(" ");
  blankView.handleInput(ENTER);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(blanks, [], "blank Enter never steers");
});

test("steer failure shows a warning while successful steering clears a prior hint", async () => {
  let shouldFail = true;
  const view = new AgentLiveManager({
    tui: fakeTUI(),
    theme: textTheme,
    live: {
      ...runningLive(),
      steer: async () => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("failed");
        }
      },
    },
    done: () => {},
  });
  view.handleInput("x");
  view.handleInput(ENTER);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(render(view).join("\n"), /Steer failed/);
  view.handleInput("y");
  view.handleInput(ENTER);
  assert.doesNotMatch(render(view).join("\n"), /Steer failed/, "new steering clears the old failure hint immediately");
  await new Promise((resolve) => setImmediate(resolve));
});

test("repeated Alt+x while confirmation is pending asks only once", async () => {
  let resolveConfirm: ((accepted: boolean) => void) | undefined;
  let confirmations = 0;
  let aborted = 0;
  const view = new AgentLiveManager({
    tui: fakeTUI(),
    theme: textTheme,
    live: runningLive(),
    abort: async () => {
      aborted++;
    },
    confirm: async () => {
      confirmations++;
      return await new Promise<boolean>((resolve) => {
        resolveConfirm = resolve;
      });
    },
    done: () => {},
  });
  view.handleInput(ALT_X);
  view.handleInput(ALT_X);
  assert.equal(confirmations, 1, "pending confirmation suppresses duplicates");
  resolveConfirm?.(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aborted, 0);
});

test("disposed view ignores late steer and cancel completions", async () => {
  let rejectSteer: ((error: Error) => void) | undefined;
  let rejectAbort: ((error: Error) => void) | undefined;
  const view = new AgentLiveManager({
    tui: fakeTUI(),
    theme: textTheme,
    live: {
      ...runningLive(),
      steer: async () => {
        await new Promise<void>((_, reject) => {
          rejectSteer = () => reject(new Error("late steer"));
        });
      },
    },
    abort: async () => {
      await new Promise<void>((_, reject) => {
        rejectAbort = () => reject(new Error("late abort"));
      });
    },
    confirm: async () => true,
    done: () => {},
  });
  view.handleInput("x");
  view.handleInput(ENTER);
  view.handleInput(ALT_X);
  await new Promise((resolve) => setImmediate(resolve));
  view.dispose();
  rejectSteer?.(new Error("late steer"));
  rejectAbort?.(new Error("late abort"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(render(view).join("\n"), /Steer failed|Cancel failed/, "late callbacks do not mutate disposed view");
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
