import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultTelegramCommandExpander, createTelegramCommandExpander } from "../src/registrations/telegram-commands.ts";

test("Telegram command expander combines explicit extension commands with prompt and skill sources", () => {
  const commands = [
    { name: "goal", description: "Goal", source: "extension" },
    { name: "review", description: "Review", source: "prompt", sourceInfo: { path: "/prompts/review.md" } },
    { name: "skill:docs", description: "Docs", source: "skill", sourceInfo: { path: "/skills/docs/SKILL.md" } },
    { name: "setup-channel-telegram", description: "TUI only", source: "extension" },
  ] as const;
  const expander = createTelegramCommandExpander({
    getCommands: () => commands,
    extensionExpanders: { goal: (args) => `GOAL:${args}` },
  });

  assert.equal(expander.expand("goal", "10s test"), "GOAL:10s test");
  assert.equal(expander.expand("review", "changes"), undefined, "default file reader cannot read fake path");
  assert.deepEqual(expander.menuSources().map((command) => command.name), ["goal", "review", "skill_docs"]);
});

test("default Telegram command expander populates the native compact control", () => {
  const expander = createDefaultTelegramCommandExpander(() => []);

  assert.deepEqual(expander.menuSources(), [
    { name: "compact", description: "Compact the current session", source: "extension" },
  ]);
});

test("Telegram command expander keeps extension command names reserved from prompt collisions", () => {
  const expander = createTelegramCommandExpander({
    getCommands: () => [
      { name: "goal", source: "prompt", sourceInfo: { path: "/prompts/goal.md" } },
    ],
    extensionExpanders: { goal: (args) => `native:${args}` },
  });
  assert.equal(expander.expand("goal", "test"), "native:test");
  assert.deepEqual(expander.menuSources().map((command) => command.name), []);
});
