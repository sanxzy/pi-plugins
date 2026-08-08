import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import {
  AgentFooter,
  filterFooterRows,
  formatDuration,
  type AgentFooterInfo,
  type FooterTreeRow,
} from "../src/agent-footer.ts";

const theme = { fg: (_color: string, text: string) => text };

function fakeTUI(): TUI {
  return { requestRender: () => {}, terminal: { rows: 24, columns: 100 } } as unknown as TUI;
}

function info(overrides: Partial<AgentFooterInfo> = {}): AgentFooterInfo {
  return {
    cwd: "/Users/test/work",
    home: "/Users/test",
    branch: "main",
    sessionName: undefined,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextPercent: 0,
    contextWindow: 200_000,
    autoCompactEnabled: true,
    model: "m",
    provider: undefined,
    providerCount: 1,
    reasoning: false,
    ...overrides,
  };
}

function row(overrides: Partial<FooterTreeRow> = {}): FooterTreeRow {
  return {
    rowId: "job-a",
    status: "running",
    depth: 0,
    description: "Explore docs",
    durationMs: 176_000,
    leaf: undefined,
    enterable: true,
    ...overrides,
  };
}

function renderRows(footer: AgentFooter, width = 100): string[] {
  return footer.render(width).map(stripVTControlCharacters);
}

test("hideRows shows the agent section only when rows exist", () => {
  const footer = new AgentFooter({
    tui: fakeTUI(),
    theme,
    getInfo: () => info(),
    getRows: () => [],
  });
  const lines = renderRows(footer);
  assert.equal(lines.length, 2, "no agent section when there are no rows");
});

test("renders a depth-first tree with status glyphs, time, and latest leaf", () => {
  const footer = new AgentFooter({
    tui: fakeTUI(),
    theme,
    getInfo: () => info(),
    getRows: () => [
      row({ rowId: "job-a", status: "running", depth: 0, description: "Explore docs", durationMs: 176_000, leaf: "⌘ grep /auth/", enterable: true }),
      row({ rowId: "job-c", status: "completed", depth: 1, description: "Summarize", durationMs: 94_000, leaf: "· found 3 files", enterable: false }),
      row({ rowId: "job-b", status: "queued", depth: 0, description: "Wait for slot", durationMs: 5_000, leaf: undefined, enterable: false }),
    ],
  });
  const lines = renderRows(footer);
  const output = lines.join("\n");
  assert.match(output, /current active subagents/i);
  assert.match(output, /Explore docs.*2m 56s/);
  assert.match(output, /⌘ grep \/auth\//);
  assert.match(output, /└─|├─/, "tree connectors drawn");
  assert.match(output, /◯/, "queued indicator drawn");
  assert.match(output, /Wait for slot/);
  for (const line of lines) assert.ok(line.length <= 100, `line fits: ${line}`);
});

test("terminal rows are filtered out after two minutes by filterFooterRows", () => {
  const updatedAt = "2026-01-01T12:00:00.000Z";
  const rows: FooterTreeRow[] = [
    row({ rowId: "done", status: "completed", updatedAt, updatedAtMs: new Date(updatedAt).getTime() }),
    row({ rowId: "running", status: "running" }),
  ];
  const inWindow = filterFooterRows(rows, new Date("2026-01-01T12:01:59.000Z"));
  assert.deepEqual(inWindow.map((r) => r.rowId), ["done", "running"]);
  const past = filterFooterRows(rows, new Date("2026-01-01T12:02:01.000Z"));
  assert.deepEqual(past.map((r) => r.rowId), ["running"]);
});

test("formatDuration renders compact elapsed time", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(56_000), "56s");
  assert.equal(formatDuration(176_000), "2m 56s");
});