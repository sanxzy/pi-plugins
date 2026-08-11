import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultTelegramCommandExpander, createTelegramCommandExpander, TELEGRAM_NATIVE_MENU_COMMANDS } from "../src/registrations/telegram-commands.ts";

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

test("default expander excludes system_prompt unless development mode is enabled", () => {
  const previous = process.env.PI_CODE_DEV;
  delete process.env.PI_CODE_DEV;
  try {
    const regular = createDefaultTelegramCommandExpander(() => []);
    const regularNames = regular.menuSources().map((command) => command.name);
    assert.equal(regularNames.includes("system_prompt"), false, "system_prompt is hidden without PI_CODE_DEV");
  } finally {
    if (previous === undefined) delete process.env.PI_CODE_DEV;
    else process.env.PI_CODE_DEV = previous;
  }

  const dev = createTelegramCommandExpander({
    getCommands: () => [],
    extensionExpanders: {},
    nativeMenuCommands: TELEGRAM_NATIVE_MENU_COMMANDS,
    isDevMode: () => true,
  });
  assert.equal(dev.menuSources().some((command) => command.name === "system_prompt"), true, "system_prompt shows in development mode");
});

test("native menu sources are populated", () => {
  const expander = createTelegramCommandExpander({
    getCommands: () => [],
    extensionExpanders: {},
    nativeMenuCommands: TELEGRAM_NATIVE_MENU_COMMANDS,
    isDevMode: () => true,
  });
  assert.deepEqual(expander.menuSources().map((command) => command.name), [
    "abort", "stop", "reload", "compact", "context", "status", "system_prompt", "model", "thinking",
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
