import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupRootSessions, createChannelOwner, createTelegramInbound, createTelegramOutbound, splitTextChunks, upsertPairingRequest, type ChannelConfig } from "../src/index.ts";
import { startRootSession } from "@xzy-ai/runtime";
import { resolveChannelSettings } from "../src/settings.ts";

function homeWith(home: string, channels: Record<string, unknown>): void {
  const dir = join(home, "pi-c2");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ channels }));
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "pi-c2-channels-settings-home-"));
}

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "pi-c2-channels-settings-project-"));
}

function withHome(home: string, run: () => void): void {
  const previous = process.env.PI_C2_TEST_HOME;
  process.env.PI_C2_TEST_HOME = home;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.PI_C2_TEST_HOME;
    else process.env.PI_C2_TEST_HOME = previous;
  }
}

test("outbound text split honors the configured maxTextLength via the explicit limit seam", () => {
  const text = "a".repeat(25);
  const chunks = splitTextChunks(text, 10);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => chunk.length <= 10));
  assert.equal(chunks.length, 3);
});

test("outbound send applies the centralized maxTextLength to chunking", async () => {
  const home = tempHome();
  try {
    homeWith(home, { maxTextLength: 5 });
    const previous = process.env.PI_C2_TEST_HOME;
    process.env.PI_C2_TEST_HOME = home;
    try {
      const sent: string[] = [];
      const outbound = createTelegramOutbound({
        readConfig: () => ({ ok: true, value: { token: "123456789:ABCDEFGHIJKLMNOPQRSTUVWX", approvedUserIds: ["777"] } }),
        createSendApi: () => ({ async sendMessage(_c, text) { sent.push(String(text)); return { message_id: 1 }; } }),
      });
      const result = await outbound.send("project", "777", "abc def ghi");
      assert.equal(result.ok, true);
      const joined = sent.join("");
      assert.equal(joined, "abc def ghi");
      assert.ok(sent.length >= 2, "text longer than the configured 5-char cap is split");
      assert.ok(sent.every((chunk) => chunk.length <= 5), "every chunk respects the configured cap");
    } finally {
      if (previous === undefined) delete process.env.PI_C2_TEST_HOME;
      else process.env.PI_C2_TEST_HOME = previous;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("outbound media size limit comes from the centralized settings per project", async () => {
  const home = tempHome();
  try {
    homeWith(home, { mediaDocumentMaxBytes: 2 });
    const previous = process.env.PI_C2_TEST_HOME;
    process.env.PI_C2_TEST_HOME = home;
    try {
      const api = createTelegramOutbound({
        readConfig: () => ({ ok: true, value: { token: "123456789:ABCDEFGHIJKLMNOPQRSTUVWX", approvedUserIds: ["777"] } }),
        createSendApi: () => ({ async sendDocument() { return { message_id: 2 }; } }),
      });
      const result = await api.sendMedia("project", "777", "document", {
        kind: "bytes", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), contentType: "application/pdf", filename: "big.pdf",
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "Media source exceeds the allowed size");
    } finally {
      if (previous === undefined) delete process.env.PI_C2_TEST_HOME;
      else process.env.PI_C2_TEST_HOME = previous;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("pairings cap at the configured centralized limit", () => {
  // The shared settings resolver requires a homeRoot; exercise the seam by
  // passing explicit settings like the inbound path does.
  const refreshTtlConfig = { token: "t", approvedUserIds: [] };
  const first = upsertPairingRequest(refreshTtlConfig, "111", new Date(), () => "CODE1", { pairingPendingTtlMs: 60_000, pairingPendingMax: 1 });
  assert.equal(first.kind, "created");
  const direct = first.kind === "created"
    ? upsertPairingRequest(first.config, "222", new Date(), () => "CODE2", { pairingPendingTtlMs: 60_000, pairingPendingMax: 1 })
    : first;
  assert.equal(direct.kind, "capped");

  // Verify the centralized resolver supplies the same settings when the home
  // config declares them.
  const home = tempHome();
  try {
    homeWith(home, { pairingPendingTtlMs: 60_000, pairingPendingMax: 1 });
    withHome(home, () => {
      const fromResolver = resolveChannelSettings("project");
      assert.equal(fromResolver.pairingPendingMax, 1);
      assert.equal(fromResolver.pairingPendingTtlMs, 60_000);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("inbound pairing uses the centralized TTL and cap for its project", async () => {
  const home = tempHome();
  const previous = process.env.PI_C2_TEST_HOME;
  try {
    homeWith(home, { pairingPendingTtlMs: 60_000, pairingPendingMax: 1 });
    process.env.PI_C2_TEST_HOME = home;
    let config: ChannelConfig = { token: "t", approvedUserIds: [] };
    const challenges: string[] = [];
    const listener = createTelegramInbound({
      projectRoot: "project",
      approvedUserIds: [],
      readConfig: () => ({ ok: true as const, value: config }),
      writeConfig: (next) => { config = next; return { ok: true as const, value: undefined }; },
      onChallenge: async (_context, _chatId, text) => { challenges.push(text); },
      onAccepted: async () => undefined,
    });
    const update = (updateId: number, userId: string) => ({
      update_id: updateId,
      message: { chat: { id: userId, type: "private" }, from: { id: userId }, text: "hello", message_id: updateId },
    });
    await listener.handle(update(1, "111"));
    await listener.handle(update(2, "222"));
    assert.equal(config.pendingPairings?.length, 1);
    assert.equal(challenges.length, 1, "the configured pending cap suppresses the second challenge");
    const expiresAt = Date.parse(config.pendingPairings?.[0]?.expiresAt ?? "");
    assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + 60_000 + 1000, "configured pairing TTL is applied");
  } finally {
    if (previous === undefined) delete process.env.PI_C2_TEST_HOME;
    else process.env.PI_C2_TEST_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("root-session retention cap comes from the centralized settings", () => {
  const home = tempHome();
  const root = tempProject();
  try {
    homeWith(home, { maxRootSessions: 2 });
    withHome(home, () => {
      for (const id of ["inactive-a", "inactive-b", "inactive-c"]) {
        startRootSession({ projectRoot: root, sessionId: id, pid: 1111, processStartTime: "old-start", now: "2020-01-01T00:00:00.000Z" });
      }
      const result = cleanupRootSessions(root, {
        currentPid: 9999,
        currentProcessStartTime: "current-start",
        isAlive: () => false,
      });
      assert.equal(result.ok, true);
      assert.equal(result.removed, 1, "configured cap 2 keeps two inactive sessions and removes the oldest");
      assert.equal(result.remaining, 2);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("cleanup and ownership accept an explicit lock-policy override seam with a shared policy", () => {
  const home = tempHome();
  const root = tempProject();
  try {
    homeWith(home, { lockStaleMs: 50_000, lockUpdateMs: 25_000, lockAcquireRetries: 0 });
    withHome(home, () => {
      const owner = createChannelOwner(root, { pid: 4444, lockStaleMs: 40_000 });
      const acquired = owner.acquire();
      assert.equal(acquired.ok, true, acquired.ok ? "acquired" : acquired.message);
      owner.release();
      const cleanup = cleanupRootSessions(root, {
        currentPid: 9999,
        lockStaleMs: 40_000,
        lockUpdateMs: 20_000,
        lockAcquireRetries: 0,
        isAlive: () => false,
      });
      assert.equal(cleanup.ok, true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});