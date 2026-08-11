import { join } from "node:path";
import { assertSessionId, canonicalProjectRoot, encodeProjectId, homeChannelConfigFile, homeChannelOwnerFile, homeChannelRuntimeFile, homeDailyEventFile, homeSessionDirFromRoot } from "@xzy-ai/runtime";

/**
 * Channels-owned home-scoped locations. Configuration, runtime cursor, and
 * owner remain project-level; activity logs are scoped to one root session.
 */
export const CHANNEL_CONFIG_FILE_NAME = "channel.json";
export const CHANNEL_RUNTIME_FILE_NAME = "channel.runtime.json";
export const CHANNEL_LOGS_DIR_NAME = "logs";
export const CHANNEL_OWNER_FILE_NAME = "channel.owner.json";

/** Project channel configuration (token, approvals, pairing state). */
export function channelConfigFile(projectRoot: string): string {
  return homeChannelConfigFile(encodeProjectId(canonicalProjectRoot(projectRoot)));
}

/** Crash-safe per-project Telegram connection owner record. */
export function channelOwnerFile(projectRoot: string): string {
  return homeChannelOwnerFile(encodeProjectId(canonicalProjectRoot(projectRoot)));
}

/** Persisted per-project channel runtime state (e.g. the Telegram update cursor). */
export function channelRuntimeFile(projectRoot: string): string {
  return homeChannelRuntimeFile(encodeProjectId(canonicalProjectRoot(projectRoot)));
}

/** Directory holding per-session structured channel logs. */
export function channelLogsDir(projectRoot: string): string {
  return join(homeSessionDirFromRoot(canonicalProjectRoot(projectRoot), "root"), "logs");
}

/** Session-scoped channel log file. */
export function channelLogFile(projectRoot: string, sessionId: string): string {
  return homeDailyEventFile(encodeProjectId(canonicalProjectRoot(projectRoot)), assertSessionId(sessionId), new Date().toISOString().slice(0, 10));
}
