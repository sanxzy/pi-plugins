import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTelegramLifecycle } from "../src/lifecycle/index.ts";
import type { TelegramListenerBot } from "../src/inbound/index.ts";

function root(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-telegram-lifecycle-"));
}

function writeChannel(root: string): void {
  const dir = join(root, ".pi", "pi-code");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "channel.json"),
    JSON.stringify({
      botToken: "123456:SECRET-TOKEN",
      defaultChatId: "42",
      allowedChatIds: ["42"],
      updatedAt: new Date().toISOString(),
    }),
    "utf8",
  );
}

function fakeBot() {
  const calls: string[] = [];
  const bot: TelegramListenerBot = {
    on: (_event, _middleware) => {},
    api: {
      getFile: async () => ({ file_path: "x.bin", file_size: 1 }),
      sendChatAction: async () => {},
      setMyCommands: async () => {
        calls.push("menu");
      },
    },
    start: async () => {
      calls.push("start");
    },
    stop: async () => {
      calls.push("stop");
    },
  };
  return { bot, calls };
}

test("lifecycle start with a channel config starts the listener and passes the command list", async () => {
  const projectRoot = root();
  try {
    writeChannel(projectRoot);
    const fake = fakeBot();
    const lifecycle = createTelegramLifecycle({
      projectRoot,
      sessionId: "root-session",
      sendFollowUp: async () => {},
      setTelegramMarker: () => {},
      createBot: () => fake.bot,
    });
    const menus: unknown[] = [];
    fake.bot.api.setMyCommands = async (commands, other) => {
      menus.push({ commands, other });
    };
    await lifecycle.start([{ name: "/status", description: "Check status" }]);
    assert.deepEqual(fake.calls, ["start"]);
    assert.deepEqual(menus, [{ commands: [{ command: "status", description: "Check status" }], other: { scope: { type: "default" } } }]);
    await lifecycle.stop();
    assert.deepEqual(fake.calls, ["start", "stop"]);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("lifecycle start with no channel config starts no listener", async () => {
  const projectRoot = root();
  try {
    const fake = fakeBot();
    const lifecycle = createTelegramLifecycle({
      projectRoot,
      sessionId: "root-session",
      sendFollowUp: async () => {},
      setTelegramMarker: () => {},
      createBot: () => fake.bot,
    });
    await lifecycle.start([]);
    assert.deepEqual(fake.calls, []);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("lifecycle stopTyping stops the loop without polling", async () => {
  const projectRoot = root();
  try {
    writeChannel(projectRoot);
    const fake = fakeBot();
    const lifecycle = createTelegramLifecycle({
      projectRoot,
      sessionId: "root-session",
      sendFollowUp: async () => {},
      setTelegramMarker: () => {},
      createBot: () => fake.bot,
    });
    await lifecycle.start([]);
    lifecycle.stopTyping();
    assert.deepEqual(fake.calls, ["menu", "start"]);
    await lifecycle.stop();
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});