import { join } from "node:path";
import { assertSessionId, runtimeDir } from "@xzy-ai/runtime";

/**
 * Channels-owned project runtime locations.
 *
 * Channel state and logs live below the existing runtime directory
 * `<project>/.pi/pi-code/`. Configuration and connection markers are single
 * files owned by the project; logs are session-scoped files retained for
 * manual removal.
 */
export const CHANNEL_CONFIG_FILE_NAME = "channel.json";
export const LAST_CONNECTION_FILE_NAME = "user_last_connection.json";
export const CHANNEL_LOGS_DIR_NAME = "logs";
export const CHANNEL_OWNER_FILE_NAME = "channel.owner.json";

/** Project channel configuration (token, approvals, pairing state). */
export function channelConfigFile(projectRoot: string): string {
  return join(runtimeDir(projectRoot), CHANNEL_CONFIG_FILE_NAME);
}

/** Crash-safe per-project Telegram connection owner record. */
export function channelOwnerFile(projectRoot: string): string {
  return join(runtimeDir(projectRoot), CHANNEL_OWNER_FILE_NAME);
}

/** Persisted last-connection marker gating outbound Telegram delivery. */
export function lastConnectionFile(projectRoot: string): string {
  return join(runtimeDir(projectRoot), LAST_CONNECTION_FILE_NAME);
}

/** Directory holding per-session structured channel logs. */
export function channelLogsDir(projectRoot: string): string {
  return join(runtimeDir(projectRoot), CHANNEL_LOGS_DIR_NAME);
}

/** Session-scoped channel log file. */
export function channelLogFile(projectRoot: string, sessionId: string): string {
  return join(channelLogsDir(projectRoot), `${assertSessionId(sessionId)}.log`);
}
