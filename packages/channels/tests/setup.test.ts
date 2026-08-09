import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createChannelManager,
  createTelegramSetupController,
  readChannelConfig,
  readLastConnection,
  type ChannelConfig,
  type ChannelManager,
  type ChannelPoller,
} from "../src/index.ts";

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-channels-setup-"));
}

const VALID = "123456789:ABCDEFGHIJKLMNOPQRSTUVWX";

function fakePoller(meta: { started?: number; stopped?: number; fail?: boolean } = {}): ChannelPoller {
  return {
    async start() {
      meta.started = (meta.started ?? 0) + 1;
      return meta.fail ? { ok: false, code: "invalid", message: "bad token" } : { ok: true, value: undefined };
    },
    async stop() {
      meta.stopped = (meta.stopped ?? 0) + 1;
    },
  };
}

function manager(root: string, meta: { started?: number; stopped?: number; fail?: boolean } = {}): ChannelManager {
  return createChannelManager({ projectRoot: root, createPoller: () => fakePoller(meta) });
}

test("submitToken writes config, marks last connection TUI, and starts the poller", async () => {
  const root = projectRoot();
  const m = manager(root);
  const controller = createTelegramSetupController({ projectRoot: root, manager: m });
  const result = await controller.submitToken(`  ${VALID}  `);
  assert.deepEqual(result, { ok: true, message: "Telegram connection ready." });
  const config = readChannelConfig(root);
  assert.equal(config.ok, true);
  if (config.ok) assert.equal(config.value.token, VALID);
  const marker = readLastConnection(root);
  assert.equal(marker.ok, true);
  if (marker.ok) assert.equal(marker.value.lastConnection, "tui");
  assert.equal(m.owner.isOwner, true);
  await m.stop();
});

test("a failed candidate restores the prior listener and leaves prior config intact", async () => {
  const root = projectRoot();
  const initial: ChannelConfig = { token: "111111111:AAAAAAAAAAAAAAAAAAAAAAAAAA", approvedUserIds: [] };
  const { writeChannelConfig } = await import("../src/state.ts");
  writeChannelConfig(root, initial);

  const failingMeta = { started: 0, stopped: 0, fail: true };
  const m = manager(root, failingMeta);
  const controller = createTelegramSetupController({ projectRoot: root, manager: m, writeConfig: () => ({ ok: true, value: undefined }) });
  m.owner.release(); // Simulate a prior active owner so the manager refuses direct start.
  const result = await controller.submitToken(VALID);
  assert.equal(result.ok, false);
  const config = readChannelConfig(root);
  assert.equal(config.ok, true);
  if (config.ok) assert.equal(config.value.token, initial.token, "prior config is preserved on failure");
  await m.stop();
});

test("a submission cancelled while in flight reports cancelled and does not own the connection", async () => {
  const root = projectRoot();
  let releaseStart: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const m = createChannelManager({
    projectRoot: root,
    createPoller: () => ({
      async start() {
        await gate;
        return { ok: true, value: undefined };
      },
      async stop() {},
    }),
  });
  const controller = createTelegramSetupController({ projectRoot: root, manager: m });
  const pending = controller.submitToken(VALID);
  await controller.cancel();
  releaseStart?.();
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /cancelled/);
  assert.equal(m.owner.isOwner, false, "a cancelled submission does not leave ownership behind");
  await m.stop();
});