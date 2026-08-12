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

test("a lone root anchor row does not keep the agent section alive", () => {
  const footer = new AgentFooter({
    tui: fakeTUI(),
    theme,
    getInfo: () => info(),
    getRows: () => [
      row({ rowId: "main", root: true, status: "active", description: "main", enterable: false }),
    ],
  });
  const lines = renderRows(footer);
  assert.equal(lines.length, 2, "root anchor alone does not show the agent section");
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

test("does not add a spacer between main and its only child", () => {
  const footer = new AgentFooter({
    tui: fakeTUI(),
    theme,
    getInfo: () => info(),
    getRows: () => [
      row({ rowId: "main", root: true, status: "active", description: "main", depth: 0, durationMs: 0, enterable: false }),
      row({ rowId: "child", status: "queued", description: "Run parallel recursive descendant", depth: 1 }),
    ],
  });

  assert.deepEqual(renderRows(footer).slice(3), [
    "",
    "⏺ main 0s",
    "└─ ◯ Run parallel recursive descendant 2m 56s",
  ]);
});

test("renders every descendant on one uniformly spaced tree row", () => {
  const footer = new AgentFooter({
    tui: fakeTUI(),
    theme,
    getInfo: () => info(),
    getRows: () => [
      row({ rowId: "main", root: true, status: "active", description: "main", depth: 0, durationMs: 0, enterable: false }),
      row({ rowId: "post", status: "completed", description: "post", depth: 1 }),
      row({ rowId: "parallel", status: "queued", description: "parallel", depth: 1 }),
      row({ rowId: "branch-a", status: "queued", description: "branch A", depth: 2 }),
      row({ rowId: "branch-a1", status: "queued", description: "branch A1", depth: 3 }),
      row({ rowId: "branch-a2", status: "queued", description: "branch A2", depth: 3 }),
      row({ rowId: "branch-b", status: "queued", description: "branch B", depth: 2 }),
      row({ rowId: "branch-b1", status: "queued", description: "branch B1", depth: 3 }),
      row({ rowId: "branch-b1-child", status: "queued", description: "branch B1 child", depth: 4 }),
      row({ rowId: "branch-b2", status: "queued", description: "branch B2", depth: 3 }),
    ],
  });

  assert.deepEqual(renderRows(footer).slice(3), [
    "",
    "⏺ main 0s",
    "├─ ✓ post 2m 56s",
    "└─ ◯ parallel 2m 56s",
    "   ├─ ◯ branch A 2m 56s",
    "   │  ├─ ◯ branch A1 2m 56s",
    "   │  └─ ◯ branch A2 2m 56s",
    "   └─ ◯ branch B 2m 56s",
    "      ├─ ◯ branch B1 2m 56s",
    "      │  └─ ◯ branch B1 child 2m 56s",
    "      └─ ◯ branch B2 2m 56s",
  ]);
  assert.equal(renderRows(footer).some((line) => line.trim() === "│"), false, "no depth-specific spacer rows");
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

test("removes the subagent section after the last retained descendant expires", () => {
  const updatedAt = "2026-01-01T12:00:00.000Z";
  const rows: FooterTreeRow[] = [
    row({ rowId: "main", root: true, status: "active", description: "main", enterable: false }),
    row({ rowId: "done", status: "completed", updatedAt, updatedAtMs: new Date(updatedAt).getTime() }),
  ];
  const past = filterFooterRows(rows, new Date("2026-01-01T12:02:01.000Z"));
  assert.deepEqual(past, []);
});

test("formatDuration renders compact elapsed time", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(56_000), "56s");
  assert.equal(formatDuration(176_000), "2m 56s");
});