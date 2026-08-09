import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runtimeDir } from "@xzy-ai/runtime";
import { loadChannelConfig } from "../src/state/index.ts";
import { createSetupController, type SetupBotSurface } from "../src/setup/setup-controller.ts";

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-channels-setup-"));
}

function botSurface(overrides: Partial<SetupBotSurface> = {}): SetupBotSurface {
  return {
    getMe: async () => ({ username: "test_bot" }),
    start: async () => {},
    stop: async () => {},
    ...overrides,
  };
}

test("fresh controller reports no existing token and starts with token step", () => {
  const root = projectRoot();
  const controller = createSetupController({ projectRoot: root, createBot: botSurface });
  const state = controller.getState();
  assert.equal(state.hasExistingToken, false);
  assert.equal(state.tokenConfigured, false);
  assert.equal(state.phase, "token");
});

test("a valid token is accepted and moves to discovery", async () => {
  const root = projectRoot();
  const controller = createSetupController({ projectRoot: root, createBot: botSurface });
  const result = await controller.setToken("123456:VALID");
  assert.deepEqual(result, { ok: true });
  assert.equal(controller.getState().tokenConfigured, true);
  assert.equal(controller.getState().phase, "discovery");
});

test("an invalid token is rejected and stays on the token step", async () => {
  const root = projectRoot();
  const controller = createSetupController({
    projectRoot: root,
    createBot: () =>
      botSurface({
        getMe: async () => {
          throw new Error("Unauthorized");
        },
      }),
  });
  const result = await controller.setToken("bad-token");
  assert.equal(result.ok, false);
  assert.equal(controller.getState().tokenConfigured, false);
});

test("existing configuration is reflected as masked keep/replace state", async () => {
  const root = projectRoot();
  const { saveChannelConfig } = await import("../src/state/index.ts");
  saveChannelConfig(root, {
    botToken: "123456:EXISTING",
    defaultChatId: "42",
    allowedChatIds: ["42"],
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const controller = createSetupController({ projectRoot: root, createBot: botSurface });
  const state = controller.getState();
  assert.equal(state.hasExistingToken, true);
  assert.equal(state.tokenConfigured, true);
  // The stored token is never exposed: only a boolean flag is revealed.
  assert.equal("existingToken" in state, false);
  assert.equal("botToken" in state, false);
});

test("confirm persists the configuration atomically and starts the replacement bot", async () => {
  const root = projectRoot();
  const started: string[] = [];
  const controller = createSetupController({
    projectRoot: root,
    createBot: (token) =>
      botSurface({
        start: async () => {
          started.push(token);
        },
      }),
  });
  await controller.setToken("123456:NEW");
  await controller.acceptDiscoveredChat("42");
  await controller.acceptDiscoveredChat("-1009");
  await controller.setDefaultChat("42");
  const result = await controller.confirm();
  assert.equal(result.ok, true);
  const config = loadChannelConfig(root);
  assert.equal(config?.botToken, "123456:NEW");
  assert.equal(config?.defaultChatId, "42");
  assert.deepEqual(config?.allowedChatIds, ["42", "-1009"]);
  assert.deepEqual(started, ["123456:NEW"]);
});

test("confirm requires the default chat to be in the allow-list", async () => {
  const root = projectRoot();
  const controller = createSetupController({
    projectRoot: root,
    createBot: (token) =>
      botSurface({
        start: async () => {},
      }),
  });
  await controller.setToken("123456:NEW");
  await controller.acceptDiscoveredChat("42");
  await controller.setDefaultChat("7");
  const result = await controller.confirm();
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /default chat/i);
});

test("cancel leaves the previous configuration and listener intact", async () => {
  const root = projectRoot();
  const { saveChannelConfig } = await import("../src/state/index.ts");
  saveChannelConfig(root, {
    botToken: "123456:OLD",
    defaultChatId: "42",
    allowedChatIds: ["42"],
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const controller = createSetupController({
    projectRoot: root,
    createBot: (token) => botSurface({ token }),
  });
  await controller.setToken("123456:NEW");
  await controller.cancel();
  const config = loadChannelConfig(root);
  assert.equal(config?.botToken, "123456:OLD");
});

test("reconfiguration never runs two polling consumers for the same token", async () => {
  const root = projectRoot();
  const { saveChannelConfig } = await import("../src/state/index.ts");
  saveChannelConfig(root, {
    botToken: "123456:OLD",
    defaultChatId: "42",
    allowedChatIds: ["42"],
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const events: string[] = [];
  const controller = createSetupController({
    projectRoot: root,
    createBot: (token) =>
      botSurface({
        start: async () => {
          events.push(`start:${token}`);
        },
        stop: async () => {
          events.push(`stop:${token}`);
        },
      }),
  });
  // The existing listener is stopped before candidate discovery.
  await controller.acceptDiscoveredChat("42");
  await controller.setDefaultChat("42");
  await controller.confirm();
  // Order must never interleave two start calls before a stop.
  assert.deepEqual(events, ["stop:123456:OLD", "start:123456:OLD"]);
});

test("keeping the existing token preserves it without loading it into the widget", async () => {
  const root = projectRoot();
  const { saveChannelConfig } = await import("../src/state/index.ts");
  saveChannelConfig(root, {
    botToken: "123456:EXISTING",
    defaultChatId: "42",
    allowedChatIds: ["42"],
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const controller = createSetupController({ projectRoot: root, createBot: botSurface });
  await controller.keepToken();
  await controller.acceptDiscoveredChat("42");
  await controller.setDefaultChat("42");
  const result = await controller.confirm();
  assert.equal(result.ok, true);
  const config = loadChannelConfig(root);
  assert.equal(config?.botToken, "123456:EXISTING");
  assert.equal(controller.getState().maskedTokenExposed, false);
});

test("a malformed existing channel file is treated as unconfigured", () => {
  const root = projectRoot();
  mkdirSync(runtimeDir(root), { recursive: true });
  writeFileSync(join(runtimeDir(root), "channel.json"), "broken", "utf-8");
  const controller = createSetupController({ projectRoot: root, createBot: botSurface });
  assert.equal(controller.getState().hasExistingToken, false);
});