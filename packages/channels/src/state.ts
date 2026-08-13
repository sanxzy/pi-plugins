import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CHANNEL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { channelConfigFile, channelRuntimeFile } from "./shared/paths.ts";

const PRIVATE_FILE_MODE = 0o600;
const TEMP_FILE_MODE = 0o600;
const TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;
const CHAT_ID_PATTERN = /^-?\d+$/;
const PAIRING_CODE_PATTERN = /^[A-Z2-9]{8}$/;

export interface PairingRequest {
  userId: string;
  code: string;
  createdAt: string;
  expiresAt: string;
}

export interface ChannelConfig {
  token: string;
  approvedUserIds: string[];
  defaultChatId?: string;
  pendingPairings?: PairingRequest[];
}

export interface ChannelRuntimeState {
  /** Highest accepted Telegram update identity, used to suppress replay after restart. */
  lastUpdateId?: number;
}

export type StateResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "missing" | "invalid" | "io"; message: string };

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/\d{5,}:[A-Za-z0-9_-]{20,}/g, "[Redacted]");
  return "Unknown filesystem error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validStringArray(value: unknown, predicate: (item: string) => boolean): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && predicate(item));
}

function parsePairing(value: unknown): PairingRequest | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.userId !== "string" ||
    !CHAT_ID_PATTERN.test(value.userId) ||
    typeof value.code !== "string" ||
    !PAIRING_CODE_PATTERN.test(value.code) ||
    typeof value.createdAt !== "string" ||
    typeof value.expiresAt !== "string"
  ) {
    return undefined;
  }
  return {
    userId: value.userId,
    code: value.code,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}

function parseConfig(value: unknown): StateResult<ChannelConfig> {
  if (!isRecord(value)) return { ok: false, code: "invalid", message: "Channel configuration must be an object" };
  if (typeof value.token !== "string" || !TOKEN_PATTERN.test(value.token)) {
    return { ok: false, code: "invalid", message: "Channel configuration has an invalid token" };
  }
  if (!validStringArray(value.approvedUserIds, (id) => CHAT_ID_PATTERN.test(id))) {
    return { ok: false, code: "invalid", message: "Channel configuration has invalid approved user IDs" };
  }
  if (value.defaultChatId !== undefined && (typeof value.defaultChatId !== "string" || !CHAT_ID_PATTERN.test(value.defaultChatId))) {
    return { ok: false, code: "invalid", message: "Channel configuration has an invalid default chat ID" };
  }
  if (value.pendingPairings !== undefined && (!Array.isArray(value.pendingPairings) || value.pendingPairings.some((item) => parsePairing(item) === undefined))) {
    return { ok: false, code: "invalid", message: "Channel configuration has invalid pairing state" };
  }

  const result: ChannelConfig = {
    token: value.token,
    approvedUserIds: [...value.approvedUserIds],
  };
  if (value.defaultChatId !== undefined) result.defaultChatId = value.defaultChatId;
  if (value.pendingPairings !== undefined) result.pendingPairings = value.pendingPairings.map((item) => parsePairing(item)!).map((item) => ({ ...item }));
  return { ok: true, value: result };
}

function parseChannelRuntime(value: unknown): StateResult<ChannelRuntimeState> {
  if (!isRecord(value)) return { ok: false, code: "invalid", message: "Channel runtime state must be an object" };
  if (value.lastUpdateId !== undefined && (!Number.isSafeInteger(value.lastUpdateId) || (value.lastUpdateId as number) < 0)) {
    return { ok: false, code: "invalid", message: "Channel runtime state has an invalid update ID" };
  }
  const result: ChannelRuntimeState = {};
  if (value.lastUpdateId !== undefined) result.lastUpdateId = value.lastUpdateId as number;
  return { ok: true, value: result };
}

function readJson<T>(filePath: string, parse: (value: unknown) => StateResult<T>): StateResult<T> {
  if (!existsSync(filePath)) return { ok: false, code: "missing", message: "State file does not exist" };
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return parse(parsed);
  } catch (error) {
    return { ok: false, code: "invalid", message: `State file is not valid JSON: ${safeErrorMessage(error)}` };
  }
}

/**
 * Atomically replace a private JSON file. The temporary file is created with
 * owner-only permissions and chmod is repeated after rename for filesystems
 * that preserve the destination mode instead of the source mode.
 */
export function writePrivateJson(filePath: string, value: unknown): StateResult<void> {
  return processWithLog({ operation: CHANNEL_OPERATIONS.STATE_WRITE, parameters: { filePath } }, () => {
  const directory = dirname(filePath);
  const temporaryPath = join(directory, `.${filePath.split("/").pop() ?? "state"}.${process.pid}.${Date.now()}.tmp`);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: TEMP_FILE_MODE, flag: "wx" });
    chmodSync(temporaryPath, PRIVATE_FILE_MODE);
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, PRIVATE_FILE_MODE);
    return { ok: true, value: undefined };
  } catch (error) {
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch {
      // Preserve the original safe failure result.
    }
    return { ok: false, code: "io", message: `Unable to write private state: ${safeErrorMessage(error)}` };
  }
  });
}

/**
 * Read-only channel config loader. Exempt from a dedicated processWithLog
 * boundary (M18): it performs no writes or side effects; every mutating
 * channel-state path is already wrapped via STATE_WRITE/STATE_CLEAR and the
 * wrapped writePrivateJson primitive.
 */
export function readChannelConfig(projectRoot: string): StateResult<ChannelConfig> {
  return readJson(channelConfigFile(projectRoot), parseConfig);
}

/** Validate a candidate config without touching disk. */
export function validateChannelConfig(config: ChannelConfig): StateResult<ChannelConfig> {
  return parseConfig(config);
}

export function writeChannelConfig(projectRoot: string, config: ChannelConfig): StateResult<void> {
  const validation = parseConfig(config);
  if (!validation.ok) return { ok: false, code: "invalid", message: validation.message };
  return writePrivateJson(channelConfigFile(projectRoot), validation.value);
}

/**
 * Read-only channel runtime loader. Exempt from a dedicated processWithLog
 * boundary (M18): it performs no writes or side effects; every mutating
 * channel-state path is already wrapped via STATE_WRITE/STATE_CLEAR and the
 * wrapped writePrivateJson primitive.
 */
export function readChannelRuntime(projectRoot: string): StateResult<ChannelRuntimeState> {
  return readJson(channelRuntimeFile(projectRoot), parseChannelRuntime);
}

export function writeChannelRuntime(projectRoot: string, state: ChannelRuntimeState): StateResult<void> {
  const validation = parseChannelRuntime(state);
  if (!validation.ok) return { ok: false, code: "invalid", message: validation.message };
  return writePrivateJson(channelRuntimeFile(projectRoot), validation.value);
}

/**
 * Remove the Telegram channel setup entirely: the persisted config (token,
 * approvals, pairing) and the anti-replay runtime cursor. Missing files are not
 * an error. Callers should stop the active manager before clearing so no
 * listener keeps polling against the removed config.
 */
export function clearChannelConfig(projectRoot: string): StateResult<void> {
  return processWithLog({ operation: CHANNEL_OPERATIONS.STATE_CLEAR, parameters: { projectRoot } }, () => {
  const files = [channelConfigFile(projectRoot), channelRuntimeFile(projectRoot)];
  try {
    for (const file of files) {
      if (existsSync(file)) unlinkSync(file);
    }
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, code: "io", message: `Unable to clear Telegram channel state: ${safeErrorMessage(error)}` };
  }
  });
}

/** Exposed for tests and diagnostics without leaking token values. */
export function privateFileMode(filePath: string): number | undefined {
  try {
    return statSync(filePath).mode & 0o777;
  } catch {
    return undefined;
  }
}
