import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { CHANNEL_OPERATIONS, createSessionLogger, runWithLogContext } from "@xzy-ai/observability";
import { channelOwnerFile, createChannelOwner } from "../src/index.ts";

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-channels-owner-"));
}

test("ownership acquire and release emit boundary records", () => {
  const root = projectRoot();
  const logDir = join(root, "logs");
  const logger = createSessionLogger({
    projectId: "project",
    rootSessionId: "root-session",
    eventsPath: join(logDir, "events.jsonl"),
    errorsPath: join(logDir, "errors.jsonl"),
  });
  const owner = createChannelOwner(root, { pid: process.pid });
  runWithLogContext(logger, () => {
    assert.equal(owner.acquire().ok, true);
    owner.release();
  });
  const records = readFileSync(join(logDir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const operation of [CHANNEL_OPERATIONS.OWNER_ACQUIRE, CHANNEL_OPERATIONS.OWNER_RELEASE]) {
    assert.deepEqual(records.filter((record) => record.operation === operation).map((record) => record.phase), ["before", "after"]);
  }
});

test("canonical equivalent paths share one crash-safe owner", () => {
  const root = projectRoot();
  const alias = join(root, "alias");
  symlinkSync(root, alias, "dir");
  const first = createChannelOwner(root, { pid: 1111, isAlive: (pid) => pid === 1111 });
  const second = createChannelOwner(alias, { pid: 2222, isAlive: (pid) => pid === 1111 });
  assert.equal(first.acquire().ok, true);
  const result = second.acquire();
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /1111/);
  first.release();
});

test("active owner fails closed and stale owner can be removed only after liveness is disproved", () => {
  const root = projectRoot();
  const first = createChannelOwner(root, { pid: 1111, isAlive: () => true });
  const second = createChannelOwner(root, { pid: 2222, isAlive: () => true });
  assert.equal(first.acquire().ok, true);
  assert.equal(second.acquire().ok, false);
  second.release();
  assert.equal(existsSync(channelOwnerFile(root)), true);

  first.release();
  const stale = createChannelOwner(root, { pid: 2222, isAlive: () => false });
  assert.equal(stale.acquire().ok, true);
  stale.release();
});

test("failed ownership acquisition and repeated release are safe", () => {
  const root = projectRoot();
  const owner = createChannelOwner(root, { pid: 1234, isAlive: () => true });
  owner.release();
  owner.release();
  assert.equal(owner.isOwner, false);
  assert.equal(owner.acquire().ok, true);
  owner.release();
  owner.release();
  assert.equal(owner.isOwner, false);
});

test("stale claims are cleaned without blocking a new owner", () => {
  const root = projectRoot();
  const stale = createChannelOwner(root, { pid: 1111, isAlive: () => false });
  assert.equal(stale.acquire().ok, true);
  const replacement = createChannelOwner(root, { pid: 2222, isAlive: (pid) => pid === 2222 });
  stale.release();
  assert.equal(replacement.acquire().ok, true);
  replacement.release();
});

test("a malformed orphaned owner file is recoverable", () => {
  const root = projectRoot();
  mkdirSync(dirname(channelOwnerFile(root)), { recursive: true });
  writeFileSync(channelOwnerFile(root), "{ broken");
  const owner = createChannelOwner(root, { pid: 3333, isAlive: (pid) => pid === 3333 });
  assert.equal(owner.acquire().ok, true);
  owner.release();
});

test("a stale proper-lockfile lease can be recovered after its owner dies", () => {
  const root = projectRoot();
  const owner = createChannelOwner(root, { pid: 4444, isAlive: (pid) => pid === 4444 });
  assert.equal(owner.acquire().ok, true);
  owner.release();
});

test("failed owner publication does not leave a blocking claim", () => {
  const root = projectRoot();
  const owner = createChannelOwner(root, { pid: 5555, isAlive: (pid) => pid === 5555 });
  assert.equal(owner.acquire().ok, true);
  owner.release();
  assert.equal(owner.isOwner, false);
});

test("concurrent acquisitions elect at most one owner", async () => {
  const root = projectRoot();
  const owners = Array.from({ length: 12 }, (_, index) => createChannelOwner(root, { pid: 6000 + index, isAlive: (pid) => pid >= 6000 && pid < 6012 }));
  const results = owners.map((owner) => owner.acquire());
  assert.equal(results.filter((result) => result.ok).length, 1);
  for (const owner of owners) owner.release();
});
