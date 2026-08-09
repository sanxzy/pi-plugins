import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runtimeDir } from "@xzy-ai/runtime";
import { saveChannelConfig, saveConnectionMarker, type ChannelConfig } from "@xzy-ai/channels";
import { registerTelegramChatTool, type TelegramChatDeps, telegramChatParams, type TelegramChatParams } from "../src/index.ts";

interface RegisteredTool {
  name: string;
  parameters: typeof telegramChatParams;
  execute: (
    toolCallId: string,
    params: TelegramChatParams,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details: Record<string, unknown> }>;
}

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-tools-telegram-"));
}

function setupChannel(root: string): void {
  const channel: ChannelConfig = {
    botToken: "123456:FAKE-TOKEN",
    defaultChatId: "42",
    allowedChatIds: ["42"],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  saveChannelConfig(root, channel);
}

function captureTool(send?: TelegramChatDeps["send"]): RegisteredTool {
  let registered: RegisteredTool | undefined;
  const pi = {
    registerTool(tool: RegisteredTool) {
      registered = tool;
    },
  } as unknown as ExtensionAPI;
  registerTelegramChatTool(pi, { send });
  assert.ok(registered);
  return registered;
}

function context(cwd: string): ExtensionContext {
  return { cwd } as unknown as ExtensionContext;
}

test("telegramChatParams requires a message string", () => {
  assert.equal(telegramChatParams.type, "object");
  assert.deepEqual(telegramChatParams.required, ["message"]);
  assert.equal(telegramChatParams.properties.message.type, "string");
});

test("tool refuses when the fresh marker is tui, missing, or malformed", async () => {
  const tool = captureTool();
  const root = projectRoot();
  setupChannel(root);

  // Missing marker
  let result = await tool.execute("call-1", { message: "hi" }, undefined, undefined, context(root));
  assert.equal(result.details.sent, false);
  assert.match(result.content[0]?.text ?? "", /^Error:/);

  // tui marker
  saveConnectionMarker(root, { lastConnection: "tui", updatedAt: "2026-01-01T00:00:00.000Z" });
  result = await tool.execute("call-2", { message: "hi" }, undefined, undefined, context(root));
  assert.equal(result.details.sent, false);
  assert.match(result.content[0]?.text ?? "", /^Error:/);

  // Malformed marker
  mkdirSync(runtimeDir(root), { recursive: true });
  writeFileSync(join(runtimeDir(root), "user_last_connection.json"), "broken", "utf-8");
  result = await tool.execute("call-3", { message: "hi" }, undefined, undefined, context(root));
  assert.equal(result.details.sent, false);
  assert.match(result.content[0]?.text ?? "", /^Error:/);
});

test("tool sends when the fresh marker is telegram and returns a structured result", async () => {
  const root = projectRoot();
  setupChannel(root);
  saveConnectionMarker(root, { lastConnection: "telegram", updatedAt: "2026-01-01T00:00:00.000Z" });
  const tool = captureTool(async (cwd, message) => {
    assert.equal(cwd, root);
    assert.equal(message, "report");
    return { ok: true, sent: 1, failed: 0 };
  });

  const result = await tool.execute("call-4", { message: "report" }, undefined, undefined, context(root));
  assert.equal(result.details.sent, true);
  assert.equal(result.details.chunks, 1);
  assert.match(result.content[0]?.text ?? "", /sent/i);
});