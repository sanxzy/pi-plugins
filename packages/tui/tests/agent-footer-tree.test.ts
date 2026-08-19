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
  assert.match(output, /1 running · 1 queued · 1 completed/, "heading summarizes live status counts");
  assert.match(output, /Explore docs.*2m 56s/);
  assert.match(output, /⌘ grep \/auth\//);
  assert.match(output, /└─|├─/, "tree connectors drawn");
  assert.match(output, /◯/, "queued indicator drawn");
  assert.match(output, /Wait for slot/);
  for (const line of lines) assert.ok(line.length <= 100, `line fits: ${line}`);
  assert.match(output, /found 3 files/);
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
    "⏺ main 0s",
    "└─ ◯ child › Run parallel recursive descendant · 0 tool uses · 0 tokens · 2m 56s",
  ]);
  assert.match(renderRows(footer)[2]!, /1 queued/, "heading carries the live summary");
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
    "⏺ main 0s",
    "├─ ✓ post › post · 0 tool uses · 0 tokens · 2m 56s",
    "└─ ◯ parallel › parallel · 0 tool uses · 0 tokens · 2m 56s",
    "   ├─ ◯ branch-a › branch A · 0 tool uses · 0 tokens · 2m 56s",
    "   │  ├─ ◯ branch-a1 › branch A1 · 0 tool uses · 0 tokens · 2m 56s",
    "   │  └─ ◯ branch-a2 › branch A2 · 0 tool uses · 0 tokens · 2m 56s",
    "   └─ ◯ branch-b › branch B · 0 tool uses · 0 tokens · 2m 56s",
    "      ├─ ◯ branch-b1 › branch B1 · 0 tool uses · 0 tokens · 2m 56s",
    "      │  └─ ◯ branch-b1-child › branch B1 child · 0 tool uses · 0 tokens · 2m 56s",
    "      └─ ◯ branch-b2 › branch B2 · 0 tool uses · 0 tokens · 2m 56s",
  ]);
  assert.match(renderRows(footer)[2]!, /8 queued · 1 completed/, "heading carries the live summary");
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

test("formatDuration renders compact elapsed time including hours", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(56_000), "56s");
  assert.equal(formatDuration(176_000), "2m 56s");
  assert.equal(formatDuration(3_573_000), "59m 33s");
  assert.equal(formatDuration(3_600_000), "1h 0m 0s");
  assert.equal(formatDuration(5_703_000), "1h 35m 3s");
});

test("heading omits the status summary for a root-only tree", () => {
  const footer = new AgentFooter({
    tui: fakeTUI(),
    theme,
    getInfo: () => info(),
    getRows: () => [
      row({ rowId: "main", root: true, status: "active", description: "main", depth: 0, durationMs: 0, enterable: false }),
      row({ rowId: "job-a", status: "running", depth: 1, description: "child" }),
    ],
  });
  const lines = renderRows(footer);
  assert.match(lines[2]!, /-- current active subagents · 1 running --/);
  assert.ok(lines[2]!.length <= 100, `heading fits: ${lines[2]}`);
});

test("running agents with live stats render as a compact stats line", () => {
  const footer = new AgentFooter({
    tui: fakeTUI(),
    theme,
    getInfo: () => info(),
    getRows: () => [
      row({ rowId: "main", root: true, status: "active", description: "main", depth: 0, durationMs: 0, enterable: false }),
      row({
        rowId: "8f2a",
        status: "running",
        depth: 1,
        description: "Trace provider compatibility",
        durationMs: 151_000,
        enterable: true,
        live: { subagentType: "explore", toolUses: 24, tokens: 18_400 },
      }),
    ],
  });

  const lines = renderRows(footer);
  assert.ok(lines.some((line) => line.includes("⏺ explore:8f2a › Trace provider compatibility · 24 tool uses · 18.4k tokens · 2m 31s")), `compact line rendered: ${lines.join("\n")}`);
  assert.ok(lines.some((line) => /[├└]─ ⏺ .*explore:8f2a/.test(line)), "live rows have status glyph and stay connected to the agent tree");
  for (const line of lines) assert.ok(line.length <= 100, `line fits: ${line}`);
});

test("live stats rows keep the tree layout for rows without counters", () => {
  const footer = new AgentFooter({
    tui: fakeTUI(),
    theme,
    getInfo: () => info(),
    getRows: () => [
      row({ rowId: "main", root: true, status: "active", description: "main", depth: 0, durationMs: 0, enterable: false }),
      row({ rowId: "queued", status: "queued", depth: 1, description: "Wait for slot", enterable: false, subagentType: "explore" }),
      row({ rowId: "done", status: "completed", depth: 1, description: "Summarize", durationMs: 94_000, enterable: false }),
    ],
  });

  const output = renderRows(footer).join("\n");
  assert.match(output, /Wait for slot/, "queued rows keep the tree layout");
  assert.match(output, /Summarize/, "settled rows keep the tree layout");
  // All rows now show the consistent format with tool uses and tokens
  assert.match(output, /◯ explore:queued › Wait for slot · 0 tool uses · 0 tokens/, "queued rows show identity and zero metrics");
  assert.match(output, /✓ done › Summarize · 0 tool uses · 0 tokens/, "completed rows show identity and zero metrics");
});