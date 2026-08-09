import { join } from "node:path";
import { runtimeDir } from "@xzy-ai/runtime";
import { readJsonFile, writeJsonFileAtomic } from "./helpers.ts";

/** Chat IDs are always serialized as strings, including negative group IDs. */
export interface ChannelConfig {
  botToken: string;
  defaultChatId: string;
  allowedChatIds: string[];
  updatedAt: string;
}

export const CHANNEL_FILE_MODE = 0o600;

/**
 * Validate the fields that must be structurally usable before a poller can be
 * created. The token check intentionally validates only Telegram's stable
 * shape; the API remains the authority for whether the token is valid.
 */
export function isValidChannelConfig(config: ChannelConfig): boolean {
  const validToken = /^[0-9]+:[A-Za-z0-9_-]+$/.test(config.botToken);
  const validChatId = (chatId: string): boolean => /^-?[0-9]+$/.test(chatId);
  const uniqueAllowed = new Set(config.allowedChatIds).size === config.allowedChatIds.length;
  return validToken &&
    validChatId(config.defaultChatId) &&
    config.allowedChatIds.length > 0 &&
    uniqueAllowed &&
    config.allowedChatIds.every(validChatId) &&
    config.allowedChatIds.includes(config.defaultChatId);
}

export function channelFilePath(projectRoot: string): string {
  return join(runtimeDir(projectRoot), "channel.json");
}

/**
 * Read the project-local channel configuration. Missing or malformed files
 * resolve to `null` so callers fail safe to unconfigured/`tui`.
 */
export function loadChannelConfig(projectRoot: string): ChannelConfig | null {
  const raw = readJsonFile(channelFilePath(projectRoot));
  if (raw === null || typeof raw !== "object") return null;
  const config = raw as Partial<ChannelConfig>;
  if (
    typeof config.botToken !== "string" ||
    typeof config.defaultChatId !== "string" ||
    !Array.isArray(config.allowedChatIds) ||
    !config.allowedChatIds.every((id): id is string => typeof id === "string") ||
    typeof config.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    botToken: config.botToken,
    defaultChatId: config.defaultChatId,
    allowedChatIds: config.allowedChatIds,
    updatedAt: config.updatedAt,
  };
}

/** Atomically persist the channel configuration with mode `0600`. */
export function saveChannelConfig(projectRoot: string, config: ChannelConfig): void {
  writeJsonFileAtomic(channelFilePath(projectRoot), config, CHANNEL_FILE_MODE);
}
