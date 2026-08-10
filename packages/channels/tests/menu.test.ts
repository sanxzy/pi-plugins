import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTelegramBotCommands,
  sanitizeTelegramCommandDescription,
  sanitizeTelegramCommandName,
  TELEGRAM_MENU_MAX_COMMANDS,
} from "../src/menu.ts";

test("sanitizeTelegramCommandName maps Pi names to Bot API command names", () => {
  assert.equal(sanitizeTelegramCommandName("fix-tests"), "fix_tests");
  assert.equal(sanitizeTelegramCommandName("Review PR"), "review_pr");
  assert.equal(sanitizeTelegramCommandName("skill:generate-doc"), "generate_doc");
  assert.equal(sanitizeTelegramCommandName("goal"), "goal");
  assert.equal(sanitizeTelegramCommandName("skill:"), undefined);
  assert.equal(sanitizeTelegramCommandName("---"), undefined);
  assert.equal(sanitizeTelegramCommandName("a".repeat(40)), "a".repeat(32));
});

test("sanitizeTelegramCommandDescription cleans and truncates to 256 chars", () => {
  assert.equal(sanitizeTelegramCommandDescription(undefined), "");
  assert.equal(sanitizeTelegramCommandDescription("  hello\nworld  "), "hello world");
  assert.equal(sanitizeTelegramCommandDescription("x".repeat(300)).length, 256);
});

test("buildTelegramBotCommands dedupes collisions and caps at 100", () => {
  const many = Array.from({ length: 120 }, (_, index) => ({
    name: `cmd_${index}`,
    description: `Desc ${index}`,
    source: "prompt" as const,
  }));
  const menu = buildTelegramBotCommands(many);
  assert.equal(menu.length, TELEGRAM_MENU_MAX_COMMANDS);

  const deduped = buildTelegramBotCommands([
    { name: "review", description: "Review A", source: "prompt" },
    { name: "review", description: "Review B (dup)", source: "skill" },
    { name: "no-desc", source: "prompt" },
  ]);
  assert.deepEqual(deduped, [{ command: "review", description: "Review A" }]);
});