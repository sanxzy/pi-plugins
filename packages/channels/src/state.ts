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
import { channelConfigFile, lastConnectionFile } from "./shared/paths.ts";

const PRIVATE_FILE_MODE = 0o600;
const TEMP_FILE_MODE = 0o600;
const TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;
const CHAT_ID_PATTERN = /^-?\d+$/;
const PAIRING_CODE_PATTERN = /^[A-Z2-9]{8}$/;

export type LastConnection = "telegram" | "tui";

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

export interface LastConnectionState {
  lastConnection?: LastConnection;
  chatRoomId?: string;
  updatedAt?: string;
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

function parseLastConnection(value: unknown): StateResult<LastConnectionState> {
  if (!isRecord(value)) return { ok: false, code: "invalid", message: "Last-connection state must be an object" };
  if (value.lastConnection !== undefined && value.lastConnection !== "telegram" && value.lastConnection !== "tui") {
    return { ok: false, code: "invalid", message: "Last-connection state has an invalid connection" };
  }
  if (value.chatRoomId !== undefined && (typeof value.chatRoomId !== "string" || !CHAT_ID_PATTERN.test(value.chatRoomId))) {
    return { ok: false, code: "invalid", message: "Last-connection state has an invalid chat ID" };
  }
  if (value.updatedAt !== undefined && typeof value.updatedAt !== "string") {
    return { ok: false, code: "invalid", message: "Last-connection state has an invalid timestamp" };
  }
  const result: LastConnectionState = {};
  if (value.lastConnection !== undefined) result.lastConnection = value.lastConnection;
  if (value.chatRoomId !== undefined) result.chatRoomId = value.chatRoomId;
  if (value.updatedAt !== undefined) result.updatedAt = value.updatedAt;
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
}

export function readChannelConfig(projectRoot: string): StateResult<ChannelConfig> {
  return readJson(channelConfigFile(projectRoot), parseConfig);
}

export function writeChannelConfig(projectRoot: string, config: ChannelConfig): StateResult<void> {
  const validation = parseConfig(config);
  if (!validation.ok) return { ok: false, code: "invalid", message: validation.message };
  return writePrivateJson(channelConfigFile(projectRoot), validation.value);
}

export function readLastConnection(projectRoot: string): StateResult<LastConnectionState> {
  return readJson(lastConnectionFile(projectRoot), parseLastConnection);
}

export function writeLastConnection(projectRoot: string, state: LastConnectionState): StateResult<void> {
  const validation = parseLastConnection(state);
  if (!validation.ok) return { ok: false, code: "invalid", message: validation.message };
  return writePrivateJson(lastConnectionFile(projectRoot), validation.value);
}

/** Exposed for tests and diagnostics without leaking token values. */
export function privateFileMode(filePath: string): number | undefined {
  try {
    return statSync(filePath).mode & 0o777;
  } catch {
    return undefined;
  }
}
