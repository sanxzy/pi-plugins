import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PAIRING_CODE_ALPHABET,
  PAIRING_PENDING_MAX,
  PAIRING_PENDING_TTL_MS,
  approvePairingAt,
  createPairingCode,
  formatPairingChallenge,
  pruneExpiredPairings,
  upsertPairingRequest,
  type ChannelConfig,
  type PairingRequest,
} from "../src/index.ts";

const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWX";
const NOW = new Date("2026-08-10T00:00:00.000Z");

function config(pendingPairings: PairingRequest[] = []): ChannelConfig {
  return { token: TOKEN, approvedUserIds: [], pendingPairings };
}

test("pairing codes use eight unambiguous uppercase characters", () => {
  const code = createPairingCode(() => 0);
  assert.equal(code.length, 8);
  assert.match(code, /^[A-Z2-9]{8}$/);
  assert.ok([...code].every((character) => PAIRING_CODE_ALPHABET.includes(character)));
});

test("first unauthorized DM creates a one-hour pending request and challenge", () => {
  const result = upsertPairingRequest(config(), "123", NOW, () => "ABCD2345");
  assert.equal(result.kind, "created");
  if (result.kind !== "created") return;
  assert.deepEqual(result.request, {
    userId: "123",
    code: "ABCD2345",
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + PAIRING_PENDING_TTL_MS).toISOString(),
  });
  assert.match(formatPairingChallenge(result.request), /ABCD2345/);
});

test("repeated DMs refresh an existing request without changing its code", () => {
  const first = upsertPairingRequest(config(), "123", NOW, () => "ABCD2345");
  assert.equal(first.kind, "created");
  if (first.kind !== "created") return;
  const later = new Date(NOW.getTime() + 10 * 60 * 1000);
  const second = upsertPairingRequest(first.config, "123", later, () => "ZZZZZZZZ");
  assert.equal(second.kind, "reused");
  if (second.kind !== "reused") return;
  assert.equal(second.request.code, "ABCD2345");
  assert.equal(second.request.createdAt, NOW.toISOString());
  assert.equal(second.request.expiresAt, new Date(later.getTime() + PAIRING_PENDING_TTL_MS).toISOString());
});

test("expired requests are pruned and can be replaced", () => {
  const expired = {
    userId: "123",
    code: "ABCD2345",
    createdAt: "2026-08-09T00:00:00.000Z",
    expiresAt: "2026-08-09T01:00:00.000Z",
  };
  assert.deepEqual(pruneExpiredPairings([expired], NOW), []);
  const result = upsertPairingRequest(config([expired]), "456", NOW, () => "EFGH2345");
  assert.equal(result.kind, "created");
});

test("pending requests cap at three and capped requests remain silent", () => {
  const pending = Array.from({ length: PAIRING_PENDING_MAX }, (_, index) => ({
    userId: String(index + 1),
    code: `ABCD234${index + 1}`,
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + PAIRING_PENDING_TTL_MS).toISOString(),
  }));
  const result = upsertPairingRequest(config(pending), "999", NOW, () => "ZZZZZZZZ");
  assert.equal(result.kind, "capped");
  if (result.kind === "capped") assert.equal(result.config.pendingPairings?.length, PAIRING_PENDING_MAX);
});

test("numeric approval authorizes a DM and removes the request", () => {
  const created = upsertPairingRequest(config(), "123", NOW, () => "ABCD2345");
  assert.equal(created.kind, "created");
  if (created.kind !== "created") return;
  const result = approvePairingAt(created.config, 1, NOW);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.config.approvedUserIds, ["123"]);
  assert.deepEqual(result.config.pendingPairings, []);
});

test("invalid approval IDs fail closed and never authorize a group request", () => {
  const result = approvePairingAt(config(), 1, NOW);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "invalid");
});
