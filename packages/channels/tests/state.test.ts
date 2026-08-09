import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runtimeDir } from "@xzy-ai/runtime";
import {
  channelFilePath,
  loadChannelConfig,
  loadConnectionMarker,
  saveChannelConfig,
  saveConnectionMarker,
  uploadsDir,
  type ChannelConfig,
  type ConnectionMarker,
} from "../src/state.ts";

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-channels-"));
}

function makeConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    botToken: "123456:TEST-TOKEN",
    defaultChatId: "42",
    allowedChatIds: ["42", "-1001234567890"],
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("channel file lives under .pi/pi-code with the canonical name", () => {
  const root = projectRoot();
  assert.equal(channelFilePath(root), join(runtimeDir(root), "channel.json"));
});

test("atomic save writes the final file and leaves no temp file behind", () => {
  const root = projectRoot();
  const file = channelFilePath(root);
  saveChannelConfig(root, makeConfig());
  assert.equal(existsSync(file), true);
  const leftovers = readdirSync(runtimeDir(root)).filter((name) => name !== "channel.json");
  assert.deepEqual(leftovers, [], "no temp or backup files may remain");
});

test("channel file is written with mode 0600", () => {
  const root = projectRoot();
  saveChannelConfig(root, makeConfig());
  const mode = statSync(channelFilePath(root)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("tolerant read returns unconfigured defaults for a missing channel file", () => {
  const root = projectRoot();
  const config = loadChannelConfig(root);
  assert.equal(config, null);
});

test("tolerant read returns unconfigured defaults for a malformed channel file", () => {
  const root = projectRoot();
  const file = channelFilePath(root);
  saveChannelConfig(root, makeConfig());
  writeFileSync(file, "{ not valid json", "utf-8");
  assert.equal(loadChannelConfig(root), null);
});

test("chat IDs round-trip as strings including negative group IDs", () => {
  const root = projectRoot();
  const config = makeConfig({
    botToken: "987654:ANOTHER-TOKEN",
    defaultChatId: "-1001234567890",
    allowedChatIds: ["-1001234567890", "-100111", "7"],
  });
  saveChannelConfig(root, config);
  const loaded = loadChannelConfig(root);
  assert.notEqual(loaded, null);
  assert.equal(loaded?.defaultChatId, "-1001234567890");
  assert.deepEqual(loaded?.allowedChatIds, ["-1001234567890", "-100111", "7"]);
});

test("saved channel JSON keeps every chat id as a string", () => {
  const root = projectRoot();
  const config = makeConfig({ defaultChatId: "-1001234567890" });
  saveChannelConfig(root, config);
  const raw = JSON.parse(readFileSync(channelFilePath(root), "utf-8")) as {
    botToken: unknown;
    defaultChatId: unknown;
    allowedChatIds: unknown;
  };
  assert.equal(typeof raw.botToken, "string");
  assert.equal(typeof raw.defaultChatId, "string");
  assert.ok(Array.isArray(raw.allowedChatIds));
  assert.equal(typeof raw.allowedChatIds[0], "string");
});

test("default chat resolution is string-exact against the allow-list", () => {
  const root = projectRoot();
  const config = makeConfig({ defaultChatId: "-1001234567890", allowedChatIds: ["-1001234567890"] });
  saveChannelConfig(root, config);
  const loaded = loadChannelConfig(root);
  assert.equal(loaded?.allowedChatIds.includes(loaded.defaultChatId), true);
});

test("marker file path, save, and tolerant load round-trip", () => {
  const root = projectRoot();
  const marker: ConnectionMarker = { lastConnection: "telegram", updatedAt: "2026-01-01T00:00:00.000Z" };
  saveConnectionMarker(root, marker);
  assert.deepEqual(loadConnectionMarker(root), marker);
  assert.equal(loadConnectionMarker(projectRoot()), null, "missing marker resolves to unset");
});

test("marker saves are atomic and leave no temp file behind", () => {
  const root = projectRoot();
  saveConnectionMarker(root, { lastConnection: "tui", updatedAt: "2026-01-01T00:00:00.000Z" });
  const leftovers = readdirSync(runtimeDir(root)).filter((name) => name !== "user_last_connection.json");
  assert.deepEqual(leftovers, []);
});

test("malformed marker resolves to unset", () => {
  const root = projectRoot();
  writeFileSync(join(runtimeDir(root), "user_last_connection.json"), "not json", "utf-8");
  assert.equal(loadConnectionMarker(root), null);
});

test("uploads path is session-scoped and validates the session id", () => {
  const root = projectRoot();
  assert.equal(uploadsDir(root, "root-session"), join(runtimeDir(root), "sessions", "root-session", "uploads"));
  assert.throws(() => uploadsDir(root, "../evil"), /Invalid session id/);
  assert.throws(() => uploadsDir(root, ""), /Invalid session id/);
});
