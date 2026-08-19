import { randomInt } from "node:crypto";
import type { ChannelConfig, PairingRequest } from "./state.ts";
import type { ChannelSettings } from "@xzy-ai/runtime";

/** OpenClaw-compatible pairing constraints for Telegram DMs. */
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_PENDING_TTL_MS = 60 * 60 * 1000;
export const PAIRING_PENDING_MAX = 3;
/** Excludes ambiguous 0/O/1/I characters from operator-entered codes. */
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type PairingRequestResult =
  | { kind: "created"; config: ChannelConfig; request: PairingRequest }
  | { kind: "reused"; config: ChannelConfig; request: PairingRequest }
  | { kind: "capped"; config: ChannelConfig };

function cloneConfig(config: ChannelConfig): ChannelConfig {
  return {
    token: config.token,
    approvedUserIds: [...config.approvedUserIds],
    ...(config.defaultChatId === undefined ? {} : { defaultChatId: config.defaultChatId }),
    ...(config.pendingPairings === undefined ? {} : { pendingPairings: config.pendingPairings.map((item) => ({ ...item })) }),
  };
}

function dateAt(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

/** Remove expired requests without mutating the supplied configuration. */
export function pruneExpiredPairings(
  pairings: readonly PairingRequest[] | undefined,
  now = new Date(),
): PairingRequest[] {
  const timestamp = now.getTime();
  return (pairings ?? [])
    .filter((request) => {
      const expiresAt = dateAt(request.expiresAt);
      return expiresAt !== undefined && expiresAt > timestamp;
    })
    .map((request) => ({ ...request }));
}

/** Generate one valid pairing code. Tests can inject a deterministic generator. */
export function createPairingCode(random = randomInt): string {
  let code = "";
  for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
    code += PAIRING_CODE_ALPHABET[random(PAIRING_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Create or refresh the pending request for one numeric Telegram sender.
 * Existing senders retain their code and receive a refreshed one-hour window.
 */
export function upsertPairingRequest(
  config: ChannelConfig,
  userId: string,
  now = new Date(),
  randomCode: () => string = () => createPairingCode(),
  settings?: Pick<ChannelSettings, "pairingPendingTtlMs" | "pairingPendingMax">,
): PairingRequestResult {
  const pending = pruneExpiredPairings(config.pendingPairings, now);
  const existing = pending.find((request) => request.userId === userId);
  const expiresAt = new Date(now.getTime() + (settings?.pairingPendingTtlMs ?? PAIRING_PENDING_TTL_MS)).toISOString();
  if (existing) {
    const request: PairingRequest = { ...existing, expiresAt };
    const nextPending = pending.map((item) => item.userId === userId ? request : item);
    const next = cloneConfig({ ...config, pendingPairings: nextPending });
    return { kind: "reused", config: next, request };
  }
  if (pending.length >= (settings?.pairingPendingMax ?? PAIRING_PENDING_MAX)) {
    return { kind: "capped", config: cloneConfig({ ...config, pendingPairings: pending }) };
  }

  const usedCodes = new Set(pending.map((request) => request.code));
  let code = randomCode();
  for (let attempt = 0; usedCodes.has(code) && attempt < 100; attempt += 1) code = randomCode();
  if (usedCodes.has(code)) {
    // This is only reachable with a broken injected generator. Fail closed by
    // leaving the pending state untouched rather than reusing another user's code.
    return { kind: "capped", config: cloneConfig({ ...config, pendingPairings: pending }) };
  }

  const request: PairingRequest = {
    userId,
    code,
    createdAt: now.toISOString(),
    expiresAt,
  };
  const next = cloneConfig({ ...config, pendingPairings: [...pending, request] });
  return { kind: "created", config: next, request };
}

export type PairingApprovalResult =
  | { ok: true; config: ChannelConfig; request: PairingRequest }
  | { ok: false; code: "invalid" | "missing"; message: string; config: ChannelConfig };

/** Approve a one-based setup-list index; group requests cannot enter this store. */
export function approvePairingAt(
  config: ChannelConfig,
  oneBasedIndex: number,
  now = new Date(),
): PairingApprovalResult {
  const pending = pruneExpiredPairings(config.pendingPairings, now);
  if (!Number.isSafeInteger(oneBasedIndex) || oneBasedIndex < 1 || oneBasedIndex > pending.length) {
    return {
      ok: false,
      code: "invalid",
      message: "Pairing approval must select a pending request by its numeric ID",
      config: cloneConfig({ ...config, pendingPairings: pending }),
    };
  }
  const request = pending[oneBasedIndex - 1]!;
  const next = cloneConfig({
    ...config,
    approvedUserIds: config.approvedUserIds.includes(request.userId)
      ? [...config.approvedUserIds]
      : [...config.approvedUserIds, request.userId],
    pendingPairings: pending.filter((item) => item.userId !== request.userId),
  });
  return { ok: true, config: next, request };
}

/** Safe text sent only for a newly-created unauthorized DM request. */
export function formatPairingChallenge(request: PairingRequest): string {
  return [
    "Telegram access requires approval.",
    `Your Telegram user ID: ${request.userId}`,
    `Pairing code: ${request.code}`,
    "Ask the project owner to approve this request in /c2-setup-channel-telegram.",
  ].join("\n");
}
