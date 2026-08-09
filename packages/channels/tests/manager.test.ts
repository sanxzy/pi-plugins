import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createChannelManager,
  createChannelOwner,
  type ChannelConfig,
  type ChannelPoller,
} from "../src/index.ts";

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-channels-manager-"));
}

const config: ChannelConfig = { token: "123456789:ABCDEFGHIJKLMNOPQRSTUVWX", approvedUserIds: [] };

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

test("two acquisitions for the same canonical project cannot own simultaneously", async () => {
  const root = projectRoot();
  const first = createChannelManager({ projectRoot: root, createPoller: () => fakePoller() });
  const second = createChannelManager({ projectRoot: root, createPoller: () => fakePoller() });
  const a = await first.start(config);
  assert.equal(a.ok, true);
  const b = await second.start(config);
  assert.equal(b.ok, false);
  if (!b.ok) assert.match(b.message, /owned/);
  await first.stop();
});

test("active owner fails closed without starting a poller", async () => {
  const root = projectRoot();
  const meta = { started: 0 };
  const first = createChannelManager({ projectRoot: root, createPoller: () => fakePoller(meta) });
  const owner = createChannelOwner(root, { pid: 99999, isAlive: () => true });
  const second = createChannelManager({ projectRoot: root, createPoller: () => fakePoller(meta), owner });
  await first.start(config);
  const result = await second.start(config);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /owned by process/);
  assert.equal(meta.started, 1);
  await first.stop();
});

test("failed startup releases ownership and does not block recovery", async () => {
  const root = projectRoot();
  const manager = createChannelManager({ projectRoot: root, createPoller: () => fakePoller({ fail: true }) });
  const first = await manager.start(config);
  assert.equal(first.ok, false);
  const second = await manager.start(config);
  assert.equal(second.ok, false);
  assert.equal(manager.owner.isOwner, false);
});

test("a throwing poller factory releases ownership", async () => {
  const root = projectRoot();
  const manager = createChannelManager({
    projectRoot: root,
    createPoller: () => {
      throw new Error("boom");
    },
  });
  const result = await manager.start(config);
  assert.equal(result.ok, false);
  assert.equal(manager.owner.isOwner, false);
});

test("normal and repeated stop release ownership exactly once and settle", async () => {
  const root = projectRoot();
  const meta = { stopped: 0 };
  const manager = createChannelManager({ projectRoot: root, createPoller: () => fakePoller(meta) });
  await manager.start(config);
  await manager.stop();
  await manager.stop();
  assert.equal(meta.stopped, 1);
  assert.equal(manager.owner.isOwner, false);
  assert.equal(manager.state().status.kind, "idle");
});

test("replacement serializes so a candidate never runs concurrently with the current listener", async () => {
  const root = projectRoot();
  const meta = { started: 0, stopped: 0 };
  const manager = createChannelManager({ projectRoot: root, createPoller: () => fakePoller(meta) });
  await manager.start(config);
  const replaced = await manager.replace(config);
  assert.equal(replaced.ok, true);
  assert.equal(meta.started, 2);
  assert.equal(meta.stopped, 1);
  await manager.stop();
});

test("an asynchronous polling failure releases ownership and exposes failed state", async () => {
  const root = projectRoot();
  const captured: { poller?: ChannelPoller } = {};
  const manager = createChannelManager({
    projectRoot: root,
    createPoller: () => {
      const poller: ChannelPoller = {
        onError: undefined,
        async start() {
          return { ok: true, value: undefined } as const;
        },
        async stop() {
          return undefined;
        },
      };
      captured.poller = poller;
      return poller;
    },
  });

  const first = await manager.start(config);
  assert.equal(first.ok, true);
  assert.equal(manager.owner.isOwner, true);
  assert.equal(manager.state().status.kind, "ready");

  // Simulate the runner reporting an unexpected polling failure.
  captured.poller?.onError?.(new Error("polling died"));
  assert.equal(manager.owner.isOwner, false);
  assert.equal(manager.state().status.kind, "failed");

  // A later start is allowed again after the failure released ownership.
  const again = await manager.start(config);
  assert.equal(again.ok, true);
  await manager.stop();
});