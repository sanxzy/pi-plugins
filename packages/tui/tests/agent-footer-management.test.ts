import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { Key } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import { AgentFooter, type AgentFooterInfo, type FooterTreeRow } from "../src/agent-footer.ts";

const theme = { fg: (_color: string, text: string) => text };

function fakeTUI(): TUI {
  return { requestRender: () => {}, terminal: { rows: 24, columns: 100 } } as unknown as TUI;
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

function rows(count: number): FooterTreeRow[] {
  return [
    {
      rowId: "main",
      root: true,
      status: "active",
      depth: 0,
      description: "main",
      durationMs: 0,
      enterable: false,
    },
    ...Array.from({ length: count }, (_, index) => ({
      rowId: `job-${index + 1}`,
      status: "running" as const,
      depth: 1,
      description: `child-${index + 1}`,
      durationMs: 1_000,
      enterable: true,
    })),
  ];
}

function makeFooter(getRows: () => readonly FooterTreeRow[]) {
  let renders = 0;
  const footer = new AgentFooter({
    tui: { ...fakeTUI(), requestRender: () => renders++ } as TUI,
    theme,
    getInfo: info,
    getRows,
  });
  return { footer, renders: () => renders };
}

function cleanLines(footer: AgentFooter): string[] {
  return footer.render(100).map(stripVTControlCharacters);
}

function treeLines(footer: AgentFooter): string[] {
  return cleanLines(footer).slice(3);
}

test("down enters management mode with main selected and navigation returns to composer", () => {
  const { footer, renders } = makeFooter(() => rows(2));

  assert.equal(footer.handleInput(Key.down), true);
  assert.match(treeLines(footer)[0]!, /^❯ .*main/);
  assert.equal(renders(), 1);

  assert.equal(footer.handleInput("x"), false, "non-navigation input passes through");
  assert.match(treeLines(footer)[0]!, /^❯ .*main/);

  assert.equal(footer.handleInput(Key.down), true);
  assert.match(treeLines(footer)[1]!, /^❯ .*child-1/);
  assert.equal(footer.handleInput(Key.up), true);
  assert.match(treeLines(footer)[0]!, /^❯ .*main/);

  assert.equal(footer.handleInput(Key.left), true);
  assert.equal(treeLines(footer).some((line) => line.startsWith("❯")), false);
  assert.equal(footer.handleInput(Key.enter), false, "Enter reaches composer outside management mode");
});

test("Enter on main exits management mode", () => {
  const { footer } = makeFooter(() => rows(1));
  footer.handleInput(Key.down);
  assert.equal(footer.handleInput(Key.enter), true);
  assert.equal(treeLines(footer).some((line) => line.startsWith("❯")), false);
});

test("management mode shows at most four rows and scrolls with selection", () => {
  const { footer } = makeFooter(() => rows(6));
  footer.handleInput(Key.down);
  assert.equal(treeLines(footer).length, 4);
  assert.match(treeLines(footer)[0]!, /main/);
  assert.match(treeLines(footer)[3]!, /child-3/);

  for (let index = 0; index < 4; index++) footer.handleInput(Key.down);
  const visible = treeLines(footer);
  assert.equal(visible.length, 4);
  assert.match(visible[3]!, /^❯ .*child-4/);
  assert.doesNotMatch(visible.join("\n"), /child-1/);
});
