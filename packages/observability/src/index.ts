import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import pino from "pino";

const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;
const TOKEN_PATTERN = /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g;
const SECRET_KEY_PATTERN = /(?:token|password|credential|api[-_]?key|api[-_]?secret|secret|authorization|bearer|cookie|private[-_]?key)/i;
const SECRET_VALUE_PATTERN = /(?:bearer\s+|api[-_]?key\s*[=:]\s*|authorization\s*[=:]\s*|credential\s*[=:]\s*|private[-_]?key\s*[=:]\s*)[^\s,;]+/gi;
const TELEGRAM_UPDATE_KEYS = new Set([
  "message", "edited_message", "channel_post", "edited_channel_post", "inline_query",
  "chosen_inline_result", "callback_query", "shipping_query", "pre_checkout_query", "poll",
  "poll_answer", "my_chat_member", "chat_member", "chat_join_request", "message_reaction",
  "message_reaction_count",
]);
const persistenceState = { failures: 0 };

export type LogPhase = "before" | "after" | "error";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface SessionLoggerOptions {
  projectId: string;
  rootSessionId: string;
  agentId?: string;
  eventsPath: string;
  errorsPath: string;
  write?: (path: string, line: string) => void;
  fallback?: (line: string) => void;
}

export interface SessionLogger {
  readonly projectId: string;
  readonly rootSessionId: string;
  readonly agentId?: string;
  readonly eventsPath: string;
  readonly errorsPath: string;
  child(bindings: Record<string, unknown>): SessionLogger;
  write(record: Record<string, unknown>): void;
}

export interface LogContext {
  readonly logger: SessionLogger;
  readonly correlationId?: string;
  readonly parentCorrelationId?: string;
}

export interface ProcessLogInput {
  operation: string;
  parameters?: unknown;
}

const contextStorage = new AsyncLocalStorage<LogContext>();
let defaultLogger: SessionLogger | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

function isUpdateKey(key: string): boolean {
  return key === "update" || key === "updates" || key === "updatePayload" || key === "telegramUpdate";
}

function isTelegramUpdate(value: Record<string, unknown>): boolean {
  return typeof value.update_id === "number" && Object.keys(value).some((key) => TELEGRAM_UPDATE_KEYS.has(key));
}

/** Mask recursively at the persistence boundary. */
export function mask(value: unknown, key?: string): unknown {
  if (typeof value === "string") return value.replace(TOKEN_PATTERN, "[Redacted]").replace(SECRET_VALUE_PATTERN, "[Redacted]");
  if (value === null || typeof value !== "object") return value;
  if (isRecord(value)) {
    if (isTelegramUpdate(value) || (key !== undefined && isUpdateKey(key))) return "[Omitted]";
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (isSecretKey(entryKey)) output[entryKey] = "[Redacted]";
      else if (isUpdateKey(entryKey)) output[entryKey] = "[Omitted]";
      else output[entryKey] = mask(entryValue, entryKey);
    }
    return output;
  }
  if (Array.isArray(value)) return value.map((item) => mask(item));
  return "[Omitted]";
}

function safeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) return { name: error.name, message: mask(error.message) as string };
  return { category: "unknown_error" };
}

function normalizeOperation(operation: string): string {
  const normalized = operation.trim().toLowerCase().replace(/[^a-z0-9.]+/g, ".").replace(/\.+/g, ".");
  return normalized.replace(/^\.|\.$/g, "") || "unknown.operation";
}

function appendPrivate(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIR });
  chmodSync(dirname(path), PRIVATE_DIR);
  appendFileSync(path, line, { encoding: "utf8", mode: PRIVATE_FILE });
  chmodSync(path, PRIVATE_FILE);
}

function emergencyLine(record: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    source: "observability",
    operation: record.operation,
    phase: record.phase,
    correlationId: record.correlationId,
    errorCategory: "persistence_failure",
    projectId: record.projectId,
    rootSessionId: record.rootSessionId,
    ...(record.agentId === undefined ? {} : { agentId: record.agentId }),
  });
}

export function createSessionLogger(options: SessionLoggerOptions): SessionLogger {
  const fallback = options.fallback ?? ((line: string) => process.stderr.write(`${line}\n`));
  const write = options.write ?? appendPrivate;
  // Keep pino as the package's low-level logging dependency. JSONL persistence
  // is performed after our masking boundary so every destination is safe.
  const pinoLogger = pino({ level: "silent", base: undefined });
  void pinoLogger;

  const create = (bindings: Record<string, unknown>): SessionLogger => ({
    projectId: options.projectId,
    rootSessionId: options.rootSessionId,
    agentId: options.agentId,
    eventsPath: options.eventsPath,
    errorsPath: options.errorsPath,
    child(childBindings) {
      const safe = mask(childBindings);
      return create({ ...bindings, ...(isRecord(safe) ? safe : {}) });
    },
    write(record) {
      const safeRecord = mask({ ...record, ...bindings }) as Record<string, unknown>;
      const path = safeRecord.phase === "error" ? options.errorsPath : options.eventsPath;
      try {
        write(path, `${JSON.stringify(safeRecord)}\n`);
      } catch (error) {
        persistenceState.failures += 1;
        try { fallback(emergencyLine({ ...safeRecord, errorCategory: error instanceof Error ? error.name : "io" })); } catch { /* best effort */ }
      }
    },
  });

  const logger = create({});
  defaultLogger = logger;
  return logger;
}

export function runWithLogContext<T>(logger: SessionLogger, callback: () => T): T {
  const parent = contextStorage.getStore();
  return contextStorage.run({ logger, parentCorrelationId: parent?.correlationId }, callback);
}

export function getLogContext(): LogContext | undefined {
  return contextStorage.getStore();
}

export function processWithLog<T>(
  input: ProcessLogInput,
  callback: (context: { logger: SessionLogger; correlationId: string; parentCorrelationId?: string }) => T,
): T {
  const ambient = contextStorage.getStore();
  const logger = ambient?.logger ?? defaultLogger;
  if (!logger) {
    return callback({ logger: createSessionLogger({ projectId: "unknown", rootSessionId: "unknown", eventsPath: "/dev/null", errorsPath: "/dev/null" }), correlationId: randomUUID() });
  }
  const correlationId = randomUUID();
  const parentCorrelationId = ambient?.correlationId;
  const started = Date.now();
  const common = {
    timestamp: new Date().toISOString(),
    level: "info" as const,
    operation: normalizeOperation(input.operation),
    correlationId,
    ...(parentCorrelationId === undefined ? {} : { parentCorrelationId }),
    projectId: logger.projectId,
    rootSessionId: logger.rootSessionId,
    ...(logger.agentId === undefined ? {} : { agentId: logger.agentId }),
    parameters: input.parameters,
  };
  logger.write({ ...common, phase: "before" });
  try {
    const result = contextStorage.run({ logger, correlationId, parentCorrelationId }, () => callback({ logger, correlationId, parentCorrelationId }));
    if (result instanceof Promise) {
      return result.then((value) => {
        logger.write({ ...common, timestamp: new Date().toISOString(), phase: "after", result: value, durationMs: Date.now() - started });
        return value;
      }).catch((error) => {
        logger.write({ ...common, timestamp: new Date().toISOString(), level: "error", phase: "error", error: safeError(error), durationMs: Date.now() - started });
        throw error;
      }) as T;
    }
    logger.write({ ...common, timestamp: new Date().toISOString(), phase: "after", result, durationMs: Date.now() - started });
    return result;
  } catch (error) {
    logger.write({ ...common, timestamp: new Date().toISOString(), level: "error", phase: "error", error: safeError(error), durationMs: Date.now() - started });
    throw error;
  }
}

export function getPersistenceFailureCount(): number {
  return persistenceState.failures;
}

export function resetPersistenceFailureCount(): void {
  persistenceState.failures = 0;
}
