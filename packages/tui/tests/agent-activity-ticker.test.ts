import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { TUI } from "@earendil-works/pi-tui";
import {
  AgentActivityTicker,
  type AgentActivitySource,
  type TickerDriver,
} from "../src/agent-activity-ticker.ts";

function fakeTUI(renders: number[] = []): TUI {
  return {
    terminal: { rows: 24, columns: 100 },
    requestRender() {
      renders.push(renders.length);
    },
  } as unknown as TUI;
}

const theme = { fg: (_color: string, text: string) => text };

function source(items: string[], subscribes: number[] = []): AgentActivitySource {
  return {
    getItems: () => items.map((text, index) => ({ jobId: `job-${index}`, text })),
    subscribe: (listener: () => void) => {
      subscribes.push(subscribes.length);
      return () => {};
    },
  };
}

/** Capture the tick callback so a test can drive the marquee manually. */
function manualDriver(): { driver: TickerDriver; tick: () => void } {
  let tick: (() => void) | undefined;
  return {
    driver: {
      start(fn: () => void) {
        tick = fn;
        return () => {
          tick = undefined;
        };
      },
    },
    tick: () => {
      tick?.();
    },
  };
}

function plainLines(lines: string[]): string[] {
  return lines.map(stripVTControlCharacters);
}

test("an empty activity source renders no lines so the composer stays untouched", () => {
  const { driver } = manualDriver();
  const ticker = new AgentActivityTicker({
    tui: fakeTUI(),
    theme,
    ticker: driver,
    source: source([]),
  });
  assert.deepEqual(ticker.render(80), [], "no running agents -> no ticker row");
  ticker.dispose();
});

test("a single running agent renders one line containing its latest activity", () => {
  const { driver } = manualDriver();
  const ticker = new AgentActivityTicker({
    tui: fakeTUI(),
    theme,
    ticker: driver,
    source: source(["⌘ bash"]),
  });
  const lines = plainLines(ticker.render(80));
  assert.equal(lines.length, 1, "exactly one ticker line");
  assert.match(lines[0], /bash/, "activity text is present");
  ticker.dispose();
});

test("multiple agents are joined by a separator and the visible window never exceeds the width", () => {
  const { driver } = manualDriver();
  const ticker = new AgentActivityTicker({
    tui: fakeTUI(),
    theme,
    ticker: driver,
    source: source([
      "⌘ bash",
      "· implementing the feature",
      "⌘ read",
    ]),
  });
  const width = 20;
  const lines = plainLines(ticker.render(width));
  assert.equal(lines.length, 1, "still a single ticker line");
  assert.ok(lines[0].length <= width, `window is at most ${width} columns, got ${lines[0].length}`);
  assert.match(lines[0], /bash/, "first agent appears in the window");
  ticker.dispose();
});

test("the marquee advances on each tick and dispose stops further animation", () => {
  const renders: number[] = [];
  const { driver, tick } = manualDriver();
  const ticker = new AgentActivityTicker({
    tui: fakeTUI(renders),
    theme,
    ticker: driver,
    source: source(["a very long activity line that will overflow the narrow ticker window"]),
  });
  const width = 16;
  const first = plainLines(ticker.render(width))[0];
  tick(); // advance the marquee
  const second = plainLines(ticker.render(width))[0];
  assert.notEqual(second, first, "the windowed content shifts as the ticker advances");
  assert.ok(renders.length >= 1, "ticking requests a re-render");

  ticker.dispose();
  const rendersAfterDispose = renders.length;
  tick();
  assert.equal(renders.length, rendersAfterDispose, "no renders are requested after dispose");
});

test("a source refresh re-reads activity and starts the marquee from the beginning", () => {
  const renders: number[] = [];
  const { driver, tick } = manualDriver();
  const ticker = new AgentActivityTicker({
    tui: fakeTUI(renders),
    theme,
    ticker: driver,
    source: source(["long overflow line that scrolls across the narrow window"]),
  });
  const width = 14;
  tick();
  tick();
  const before = plainLines(ticker.render(width))[0];

  // A running agent emitted new activity; the host invalidates the widget and
  // the next render restarts the marquee window from the fresh content.
  ticker.invalidate();
  const after = plainLines(ticker.render(width))[0];
  assert.notEqual(after, before, "a refreshed render restarts the marquee window");
  assert.ok(renders.length >= 2, "animation and refresh both request renders");
  ticker.dispose();
});