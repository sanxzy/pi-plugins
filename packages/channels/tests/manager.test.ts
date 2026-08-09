import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  acquireTelegramChannelManager,
  channelStatusPath,
  loadChannelStatus,
  resetTelegramChannelManagers,
  saveChannelConfig,
  type TelegramChannelManager,
  type TelegramPoller,
  type TelegramPollerCallbacks,
} from "../src/index.ts";
import type { ChannelConfig } from "../src/state/index.ts";

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-telegram-manager-"));
}

function writeConfig(root: string, overrides: Partial<ChannelConfig> = {}): void {
  saveChannelConfig(root, {
    botToken: "123456:SECRET-TOKEN",
    defaultChatId: "42",
    allowedChatIds: ["42"],
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

class DeferredPoller implements TelegramPoller {
  readonly calls: string[] = [];
  private readonly callbacks: TelegramPollerCallbacks;
  private readonly validationError: unknown;
  private resolveStarted!: () => void;
  private resolveTask!: () => void;
  private rejectTask!: (error: unknown) => void;
  private readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });
  readonly task = new Promise<void>((resolve, reject) => {
    this.resolveTask = resolve;
    this.rejectTask = reject;
  });

  constructor(callbacks: TelegramPollerCallbacks, validationError?: unknown) {
    this.callbacks = callbacks;
    this.validationError = validationError;
  }

  async validate(): Promise<void> {
    this.calls.push("validate");
    if (this.validationError !== undefined) throw this.validationError;
  }

  async start(): Promise<void> {
    this.calls.push("start");
    this.resolveStarted();
    await this.task;
  }

  async stop(): Promise<void> {
    this.calls.push("stop");
    this.resolveTask();
  }

  fail(error: unknown): void {
    this.rejectTask(error);
  }

  async emitCycle(updates: readonly unknown[] = []): Promise<void> {
    await this.callbacks.onCycle(updates);
  }

  emitError(error: unknown): void {
    this.callbacks.onError(error);
  }

  async waitUntilStarted(): Promise<void> {
    await this.started;
  }
}

function managerWithPollers(root: string): { manager: TelegramChannelManager; pollers: DeferredPoller[] } {
  const pollers: DeferredPoller[] = [];
  const manager = acquireTelegramChannelManager(root, {
    createPoller: (_config, callbacks) => {
      const poller = new DeferredPoller(callbacks);
      pollers.push(poller);
      return poller;
    },
  });
  return { manager, pollers };
}

async function cleanup(manager: TelegramChannelManager, root: string): Promise<void> {
  await manager.dispose();
  await resetTelegramChannelManagers();
  rmSync(root, { recursive: true, force: true });
}

test("manager acquisition is singleton per canonical cwd and isolated across cwds", async () => {
  const root = projectRoot();
  const alias = join(root, "alias");
  symlinkSync(root, alias, "dir");
  const other = projectRoot();
  const first = acquireTelegramChannelManager(root);
  const second = acquireTelegramChannelManager(alias);
  const separate = acquireTelegramChannelManager(other);
  assert.equal(first, second);
  assert.notEqual(first, separate);
  await first.dispose();
  await separate.dispose();
  await resetTelegramChannelManagers();
  rmSync(root, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});

test("readiness follows the first completed empty or non-empty poll cycle, not task start", async () => {
  const root = projectRoot();
  writeConfig(root);
  const { manager, pollers } = managerWithPollers(root);
  const starting = manager.start([]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(pollers.length, 1);
  const poller = pollers[0]!;
  await poller.waitUntilStarted();
  assert.equal(manager.status().state, "starting");
  let taskResolved = false;
  void poller.task.then(() => {
    taskResolved = true;
  });
  await poller.emitCycle([]);
  await starting;
  assert.equal(manager.status().state, "connected");
  assert.equal(taskResolved, false);
  await cleanup(manager, root);
});

test("authentication validation failures block safely and release the poller", async () => {
  const root = projectRoot();
  writeConfig(root);
  const pollers: DeferredPoller[] = [];
  const manager = acquireTelegramChannelManager(root, {
    createPoller: (_config, callbacks) => {
      const poller = new DeferredPoller(callbacks, { error_code: 401, description: "Unauthorized" });
      pollers.push(poller);
      return poller;
    },
  });
  await assert.rejects(manager.start([]), /Telegram authentication failed/);
  assert.equal(manager.status().state, "blocked");
  assert.equal(manager.status().lastError, "Telegram authentication failed");
  assert.deepEqual(pollers[0]!.calls, ["validate", "stop"]);
  await cleanup(manager, root);
});

test("fatal errors block safely while transient errors recover on a later cycle", async () => {
  const root = projectRoot();
  writeConfig(root);
  const { manager, pollers } = managerWithPollers(root);
  const starting = manager.start([]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const poller = pollers[0]!;
  await poller.waitUntilStarted();
  poller.emitError({ error_code: 409, description: "terminated by other getUpdates request" });
  await assert.rejects(starting, /Telegram polling conflict/);
  assert.equal(manager.status().state, "blocked");
  assert.equal(manager.status().lastError, "Telegram polling conflict");
  assert.equal(manager.status().nextStep, "Stop the other Telegram poller, then restart the channel.");
  await manager.stop();

  const recovery = manager.start([]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const recoveredPoller = pollers[1]!;
  await recoveredPoller.waitUntilStarted();
  await recoveredPoller.emitCycle([]);
  await recovery;
  recoveredPoller.emitError({ error_code: 429, description: "retry later" });
  assert.equal(manager.status().state, "recovering");
  await recoveredPoller.emitCycle([{ update_id: 1 }]);
  assert.equal(manager.status().state, "connected");
  await cleanup(manager, root);
});

test("replacement is serialized and late callbacks from the old generation are fenced", async () => {
  const root = projectRoot();
  writeConfig(root);
  const { manager, pollers } = managerWithPollers(root);
  const firstStart = manager.start([]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const first = pollers[0]!;
  await first.waitUntilStarted();
  await first.emitCycle([]);
  await firstStart;

  const replacement = manager.reload([]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(first.calls, ["validate", "start", "stop"]);
  assert.equal(pollers.length, 2);
  const second = pollers[1]!;
  await second.waitUntilStarted();
  assert.equal(manager.status().state, "starting");
  await first.emitCycle([{ update_id: 99 }]);
  assert.equal(manager.status().state, "starting");
  await second.emitCycle([]);
  await replacement;
  assert.equal(manager.status().state, "connected");
  await manager.stop();
  await manager.stop();
  await cleanup(manager, root);
});

test("non-empty first cycle establishes readiness", async () => {
  const root = projectRoot();
  writeConfig(root);
  const { manager, pollers } = managerWithPollers(root);
  const starting = manager.start([]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const poller = pollers[0]!;
  await poller.waitUntilStarted();
  await poller.emitCycle([{ update_id: 1 }]);
  await starting;
  assert.equal(manager.status().state, "connected");
  await cleanup(manager, root);
});

test("polling task exit before readiness rejects and releases the poller", async () => {
  const root = projectRoot();
  writeConfig(root);
  const { manager, pollers } = managerWithPollers(root);
  const starting = manager.start([]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const poller = pollers[0]!;
  await poller.waitUntilStarted();
  poller.fail(new Error("polling stopped"));
  await assert.rejects(starting, /temporarily unavailable/);
  assert.equal(manager.status().state, "blocked");
  assert.deepEqual(poller.calls, ["validate", "start", "stop"]);
  await cleanup(manager, root);
});

test("semantically invalid configuration is unconfigured without a poller", async () => {
  const root = projectRoot();
  writeConfig(root, { defaultChatId: "not-a-chat", allowedChatIds: ["42"] });
  const created: unknown[] = [];
  const manager = acquireTelegramChannelManager(root, {
    createPoller: () => {
      created.push(true);
      throw new Error("must not create");
    },
  });
  await manager.start([]);
  assert.equal(manager.status().state, "unconfigured");
  assert.deepEqual(created, []);
  await cleanup(manager, root);
});

test("reset disposes active managers before clearing the registry", async () => {
  const root = projectRoot();
  writeConfig(root);
  const { manager, pollers } = managerWithPollers(root);
  const starting = manager.start([]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await pollers[0]!.waitUntilStarted();
  await pollers[0]!.emitCycle([]);
  await starting;
  await resetTelegramChannelManagers();
  assert.deepEqual(pollers[0]!.calls, ["validate", "start", "stop"]);
  rmSync(root, { recursive: true, force: true });
});

test("invalid configuration is unconfigured without a poller or status secret", async () => {
  const root = projectRoot();
  const created: unknown[] = [];
  const manager = acquireTelegramChannelManager(root, {
    createPoller: () => {
      created.push(true);
      throw new Error("must not create");
    },
  });
  await manager.start([]);
  assert.equal(manager.status().state, "unconfigured");
  assert.deepEqual(created, []);
  assert.equal(existsSync(channelStatusPath(root)), true);
  const raw = readFileSync(channelStatusPath(root), "utf8");
  assert.equal(raw.includes("SECRET-TOKEN"), false);
  assert.equal(loadChannelStatus(root)?.state, "unconfigured");
  await cleanup(manager, root);
});
