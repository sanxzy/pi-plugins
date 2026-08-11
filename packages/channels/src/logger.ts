import { chmodSync } from "node:fs";
import pino, { type DestinationStream, type Logger } from "pino";
import { ensurePrivateDirectory } from "@xzy-ai/runtime";
import { channelLogFile } from "./shared/paths.ts";
import type { StateResult } from "./state.ts";

/** Named fields and nested values that must never be written to channel logs. */
const REDACT_PATHS = [
  "token",
  "botToken",
  "*.token",
  "*.botToken",
  "apiSecret",
  "*.apiSecret",
];
const TELEGRAM_UPDATE_KEYS = new Set([
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "inline_query",
  "chosen_inline_result",
  "callback_query",
  "shipping_query",
  "pre_checkout_query",
  "poll",
  "poll_answer",
  "my_chat_member",
  "chat_member",
  "chat_join_request",
  "message_reaction",
  "message_reaction_count",
]);
const TOKEN_PATTERN = /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g;

export interface ChannelLogOptions {
  projectRoot: string;
  sessionId: string;
  /** Optional destination stream override (used by tests). */
  destination?: DestinationStream;
}

/** Result of creating a session logger. */
export type ChannelLogResult = StateResult<ChannelLogger>;

/**
 * Session-scoped channel logger.
 *
 * Writes structured JSONL to `<project>/.pi/pi-code/logs/<sessionId>.log`.
 * The token and API secrets are redacted by pino and by the safe-metadata
 * boundary below. Callers pass only safe metadata, never full Telegram update
 * payloads, so those values are omitted before pino serializes them.
 */
export interface ChannelLogger {
  readonly sessionId: string;
  readonly filePath: string;
  child(bindings: Record<string, unknown>): ChannelLogger;
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSecretKey(key: string): boolean {
  return /(?:token|api[-_]?secret|secret)/i.test(key);
}

function isUpdateKey(key: string): boolean {
  return key === "update" || key === "updates" || key === "updatePayload" || key === "telegramUpdate";
}

function isTelegramUpdate(value: Record<string, unknown>): boolean {
  return (
    typeof value.update_id === "number" &&
    Object.keys(value).some((key) => TELEGRAM_UPDATE_KEYS.has(key))
  );
}

function redactString(value: string): string {
  return value.replace(TOKEN_PATTERN, "[Redacted]");
}

/**
 * Strip sensitive and full-update values independently of caller-chosen field
 * names. This keeps the public logger API useful for operational metadata while
 * enforcing the privacy boundary at the last point before serialization.
 */
function safeMetadata(value: unknown, key?: string): unknown {
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object" || value === null) return value;
  if (isRecord(value)) {
    if (isTelegramUpdate(value) || (key !== undefined && isUpdateKey(key))) return "[Omitted]";
    const result: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (isSecretKey(entryKey)) {
        result[entryKey] = "[Redacted]";
      } else if (isUpdateKey(entryKey)) {
        result[entryKey] = "[Omitted]";
      } else {
        result[entryKey] = safeMetadata(entryValue, entryKey);
      }
    }
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => safeMetadata(item));
  return "[Omitted]";
}

function safeFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  const value = safeMetadata(fields);
  return isRecord(value) ? value : {};
}

function buildChannelLogger(base: Logger, sessionId: string, filePath: string): ChannelLogger {
  const self: ChannelLogger = {
    sessionId,
    filePath,
    child(bindings) {
      return buildChannelLogger(base.child(safeFields(bindings)), sessionId, filePath);
    },
    debug(event, fields) {
      base.debug({ event: redactString(event), ...safeFields(fields) });
    },
    info(event, fields) {
      base.info({ event: redactString(event), ...safeFields(fields) });
    },
    warn(event, fields) {
      base.warn({ event: redactString(event), ...safeFields(fields) });
    },
    error(event, fields) {
      base.error({ event: redactString(event), ...safeFields(fields) });
    },
    close() {
      base.flush?.();
    },
  };
  return self;
}

export function createChannelLogger(options: ChannelLogOptions): ChannelLogResult {
  try {
    const filePath = channelLogFile(options.projectRoot, options.sessionId);
    // Create and repair the actual dated session-log directory before pino
    // opens the destination. All home ancestors and the file are private.
    const logDirectory = filePath.slice(0, filePath.lastIndexOf("/"));
    ensurePrivateDirectory(logDirectory);

    // Default destination is a synchronous file destination. Synchronous
    // writes make `close` deterministic for the short lifecycle log entries
    // emitted during setup and shutdown.
    const destination = options.destination ?? pino.destination({ dest: filePath, append: true, mkdir: true, sync: true });
    chmodSync(filePath, 0o600);

    const logger = pino(
      {
        level: "info",
        base: undefined,
        timestamp: pino.stdTimeFunctions.isoTime,
        redact: {
          paths: REDACT_PATHS,
          censor: "[Redacted]",
        },
      },
      destination,
    ).child({ sessionId: options.sessionId });

    return { ok: true, value: buildChannelLogger(logger, options.sessionId, filePath) };
  } catch {
    return { ok: false, code: "io", message: "Unable to create channel log" };
  }
}
