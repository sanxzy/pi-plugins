import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeTelegramCommands } from "../src/menu/index.ts";

test("sanitizes Telegram command names and descriptions", () => {
  const commands = sanitizeTelegramCommands([
    { name: "/Deploy-Now", description: "  Deploy\n the   application  " },
    { name: " /HELP/", description: "\t" },
  ]);

  assert.deepEqual(commands, [
    { command: "deploynow", description: "Deploy the application" },
    { command: "help", description: "Run Pi command" },
  ]);
});

test("keeps the first sanitized collision and skips invalid names", () => {
  const commands = sanitizeTelegramCommands([
    { name: "/Status", description: "first" },
    { name: "status", description: "second" },
    { name: "////", description: "invalid" },
  ]);

  assert.deepEqual(commands, [{ command: "status", description: "first" }]);
});

test("truncates names and descriptions and publishes at most 100 commands", () => {
  const commands = sanitizeTelegramCommands([
    { name: `/${"a".repeat(40)}`, description: "d".repeat(300) },
    ...Array.from({ length: 100 }, (_, index) => ({ name: `/command_${index}`, description: `Command ${index}` })),
  ]);

  assert.equal(commands.length, 100);
  assert.equal(commands[0]?.command, "a".repeat(32));
  assert.equal(commands[0]?.description.length, 256);
});
