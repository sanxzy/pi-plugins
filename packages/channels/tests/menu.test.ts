import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeTelegramCommands, syncTelegramCommands } from "../src/menu/index.ts";

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

test("menu sync uses the default scope and does not block on failure", async () => {
  const calls: Array<{ commands: unknown; other: unknown }> = [];
  let warning = "";
  await syncTelegramCommands(
    {
      setMyCommands: async (commands, other) => {
        calls.push({ commands, other });
      },
    },
    [{ name: "/help", description: "Help" }],
    (message) => {
      warning = message;
    },
  );
  assert.deepEqual(calls, [{ commands: [{ command: "help", description: "Help" }], other: { scope: { type: "default" } } }]);
  assert.equal(warning, "");

  const warn: (message: string) => void = (message) => {
    warning = message;
  };
  await syncTelegramCommands(
    { setMyCommands: async () => { throw new Error("offline"); } },
    [{ name: "/help", description: "Help" }],
    warn,
  );
  assert.equal(warning, "Telegram command menu sync failed");
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
