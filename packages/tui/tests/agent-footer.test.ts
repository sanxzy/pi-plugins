import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import { AgentFooter, type AgentFooterInfo } from "../src/agent-footer.ts";

const theme = {
  fg: (_color: string, text: string) => text,
};

function fakeTUI(): TUI {
  return { requestRender: () => {}, terminal: { rows: 24, columns: 100 } } as unknown as TUI;
}

function info(overrides: Partial<AgentFooterInfo> = {}): AgentFooterInfo {
  return {
    cwd: "/Users/test/Documents/project",
    home: "/Users/test",
    branch: "main",
    sessionName: undefined,
    input: 31_000,
    output: 890,
    cacheRead: 19_000,
    cacheWrite: 0,
    cacheHitRate: 73.5,
    cost: 0,
    contextPercent: 2.4,
    contextWindow: 340_000,
    autoCompactEnabled: true,
    model: "sanxz_models",
    provider: undefined,
    providerCount: 1,
    thinkingLevel: "xhigh",
    reasoning: true,
    ...overrides,
  };
}

test("renders native-style path and usage rows within the requested width", () => {
  const footer = new AgentFooter({
    tui: fakeTUI(),
    theme,
    getInfo: () => info(),
  });

  const lines = footer.render(100).map(stripVTControlCharacters);
  assert.equal(lines[0], "~/Documents/project (main)");
  assert.match(lines[1]!, /↑31k/);
  assert.match(lines[1]!, /↓890/);
  assert.match(lines[1]!, /R19k/);
  assert.match(lines[1]!, /CH73\.5%/);
  assert.match(lines[1]!, /2\.4%\/340k \(auto\)/);
  assert.match(lines[1]!, /sanxz_models • xhigh$/);
  assert.ok(lines.every((line) => line.length <= 100));
});

test("renders provider, session name, unknown context, and narrow widths safely", () => {
  const footer = new AgentFooter({
    tui: fakeTUI(),
    theme,
    getInfo: () => info({
      branch: null,
      sessionName: "work",
      provider: "anthropic",
      providerCount: 2,
      contextPercent: null,
      contextWindow: 200_000,
      model: "claude",
      thinkingLevel: "off",
      reasoning: true,
    }),
  });

  const lines = footer.render(64).map(stripVTControlCharacters);
  assert.ok(lines.length >= 2);
  assert.ok(lines.every((line) => line.length <= 64));
  assert.match(lines[0]!, /work$/);
  assert.match(lines[1]!, /claude/);
  assert.match(lines[1]!, /\?\/200k \(auto\)/);

  const narrowLines = footer.render(32).map(stripVTControlCharacters);
  assert.ok(narrowLines.every((line) => line.length <= 32));
});

test("disposes the supplied subscription and invalidates safely", () => {
  let disposed = 0;
  const footer = new AgentFooter({
    tui: fakeTUI(),
    theme,
    getInfo: () => info(),
    dispose: () => {
      disposed++;
    },
  });

  footer.invalidate();
  footer.dispose();
  footer.dispose();
  assert.equal(disposed, 1);
});
