import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  channelConfigFile,
  channelRuntimeFile,
  privateFileMode,
  readChannelConfig,
  readChannelRuntime,
  writeChannelConfig,
  writeChannelRuntime,
} from "../src/index.ts";

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-channels-state-"));
}

const tokenA = "123456789:ABCDEFGHIJKLMNOPQRSTUVWX";
const tokenB = "987654321:ZYXWVUTSRQPONMLKJIHGFEDC";

 test("writes and replaces private channel configuration while preserving empty approvals", () => {
  const root = projectRoot();
  const first = writeChannelConfig(root, { token: tokenA, approvedUserIds: [] });
  assert.equal(first.ok, true);
  assert.equal(privateFileMode(channelConfigFile(root)), 0o600);
  assert.deepEqual(readChannelConfig(root), { ok: true, value: { token: tokenA, approvedUserIds: [] } });

  const replacement = writeChannelConfig(root, {
    token: tokenB,
    approvedUserIds: ["12345"],
    defaultChatId: "12345",
    pendingPairings: [{ userId: "67890", code: "ABCD2345", createdAt: "2026-08-09T00:00:00.000Z", expiresAt: "2026-08-09T01:00:00.000Z" }],
  });
  assert.equal(replacement.ok, true);
  assert.equal(privateFileMode(channelConfigFile(root)), 0o600);
  assert.deepEqual(readChannelConfig(root), {
    ok: true,
    value: {
      token: tokenB,
      approvedUserIds: ["12345"],
      defaultChatId: "12345",
      pendingPairings: [{ userId: "67890", code: "ABCD2345", createdAt: "2026-08-09T00:00:00.000Z", expiresAt: "2026-08-09T01:00:00.000Z" }],
    },
  });
});

test("fails closed for missing, malformed, and structurally invalid state without returning token contents", () => {
  const root = projectRoot();
  assert.deepEqual(readChannelConfig(root), { ok: false, code: "missing", message: "State file does not exist" });

  const write = writeChannelConfig(root, { token: "not-a-token", approvedUserIds: [] });
  assert.equal(write.ok, false);
  assert.equal(write.code, "invalid");
  assert.equal(write.message.includes("not-a-token"), false);

  const malformed = writeChannelConfig(root, { token: tokenA, approvedUserIds: [] });
  assert.equal(malformed.ok, true);
  const path = channelConfigFile(root);
  const original = readFileSync(path, "utf8");
  writeFileSync(path, "{ broken", { mode: 0o600 });
  const result = readChannelConfig(root);
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid");
  assert.equal(result.message.includes(tokenA), false);
  writeFileSync(path, original, { mode: 0o600 });
});

test("channel runtime state persists the update cursor privately and tolerates absence", () => {
  const root = projectRoot();
  assert.deepEqual(readChannelRuntime(root), { ok: false, code: "missing", message: "State file does not exist" });

  assert.equal(writeChannelRuntime(root, { lastUpdateId: 42 }).ok, true);
  assert.equal(privateFileMode(channelRuntimeFile(root)), 0o600);
  assert.deepEqual(readChannelRuntime(root), { ok: true, value: { lastUpdateId: 42 } });

  assert.equal(writeChannelRuntime(root, {}).ok, true);
  assert.deepEqual(readChannelRuntime(root), { ok: true, value: {} });
});
