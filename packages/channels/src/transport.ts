import { Bot } from "grammy";
import { run } from "@grammyjs/runner";
import type { ChannelLogger } from "./logger.ts";
import { TELEGRAM_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import type { ChannelPoller } from "./manager.ts";
import type { ChannelConfig, StateResult } from "./state.ts";
import type { TelegramBotCommand } from "./menu.ts";

/**
 * Minimal structural contracts for the grammY polling surface. The real grammY
 * `Bot` and `@grammyjs/runner` handle satisfy these structurally, while tests
 * inject fakes so no live Telegram network is touched.
 */
export interface TelegramCommandScope {
  type: "default" | "all_private_chats" | "chat";
  chat_id?: number | string;
}

export interface BotApiLike {
  getMe(): Promise<unknown>;
  sendMessage?(chatId: number | string, text: string, other?: Record<string, unknown>): Promise<unknown>;
  setMyCommands?(commands: readonly TelegramBotCommand[], other?: { scope?: TelegramCommandScope }): Promise<unknown>;
  answerCallbackQuery?(callbackQueryId: string): Promise<unknown>;
  editMessageReplyMarkup?(chatId: number | string, messageId: number, other?: Record<string, unknown>): Promise<unknown>;
}

export type TelegramMessageHandler = (context: unknown) => Promise<unknown> | unknown;

export interface BotLike {
  readonly api: BotApiLike;
  on?(event: "message" | "callback_query", middleware: TelegramMessageHandler): void;
  init(signal?: AbortSignal): Promise<void>;
  catch(handler: (error: unknown) => unknown): void;
  stop(): Promise<void>;
}

export interface RunnerHandleLike {
  stop(): Promise<void>;
  isRunning(): boolean;
  task(): Promise<void> | undefined;
}

export interface TelegramRunnerOptionsLike {
  runner?: { silent?: boolean; fetch?: { allowed_updates?: readonly ("message" | "callback_query")[] } };
}

export type TelegramBotFactory = (token: string) => BotLike;
export type TelegramRunnerFactory = (bot: BotLike, options: TelegramRunnerOptionsLike) => RunnerHandleLike;

export interface TelegramTransportDeps {
  /** Session-scoped safe logger. Secrets are redacted at the logger boundary. */
  logger: ChannelLogger;
  /** Injectable bot factory; defaults to a real grammY `Bot`. */
  createBot?: TelegramBotFactory;
  /** Injectable long-polling runner; defaults to `@grammyjs/runner`'s `run`. */
  runBot?: TelegramRunnerFactory;
  /**
   * Optional message middleware installed on the bot before polling starts.
   * Phase 6 uses this to route accepted private text to the root parent.
   */
  onMessage?: TelegramMessageHandler;
  /** Callback-query middleware for single-use inline choices. */
  onCallbackQuery?: TelegramMessageHandler;
  /**
   * Optional sanitized bot command menu published via `setMyCommands` before
   * polling starts and refreshed by `/start` or `/help`. A getter keeps the
   * menu current when Pi reloads commands after the transport is created.
   * Best-effort: sync failures are logged but do not stop polling.
   */
  commands?: readonly TelegramBotCommand[] | (() => readonly TelegramBotCommand[]);
  /** Restricted update stream for the runner; choices use message + callback_query only. */
  allowedUpdates?: readonly ("message" | "callback_query")[];
}

/**
 * A stable, non-cryptographic token fingerprint used only to detect duplicate
 * in-process pollers. The raw token is never stored or logged.
 */
export function telegramTokenFingerprint(token: string): string {
  let hash = 5381;
  for (let index = 0; index < token.length; index += 1) {
    hash = ((hash << 5) + hash + token.charCodeAt(index)) >>> 0;
  }
  return `telegram:${hash.toString(16)}`;
}

const TOKEN_PATTERN = /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g;

/** Strip any token-like value from an error message before it reaches a log. */
function safeTransportError(error: unknown): string {
  if (!(error instanceof Error)) return "Telegram transport error";
  return (error.message ?? "Telegram transport error").replace(TOKEN_PATTERN, "[Redacted]");
}

/** In-process registry of active token fingerprints (one poller per token). */
const activeTokenFingerprints = new Set<string>();

/**
 * Create a grammY-backed long-polling transport behind the `ChannelPoller`
 * contract. `start` validates the token via `bot.init()` (a `getMe` probe) and
 * then launches the long-polling runner without ever awaiting the loop, so the
 * caller's readiness path never blocks on the never-ending poll. Polling and
 * middleware errors are caught and routed through the safe logger and the
 * optional `onError` callback rather than becoming unhandled rejections. Stop
 * is idempotent and releases the in-process token fingerprint.
 */
function telegramCommandFromContext(context: unknown): "start" | "help" | undefined {
  if (!context || typeof context !== "object") return undefined;
  const value = context as {
    message?: { text?: unknown };
    update?: { message?: { text?: unknown } };
  };
  const text = value.message?.text ?? value.update?.message?.text;
  if (typeof text !== "string") return undefined;
  const match = text.trim().match(/^\/(start|help)(?:@[^\s]+)?(?:\s|$)/i);
  return match?.[1]?.toLowerCase() as "start" | "help" | undefined;
}

export function createTelegramTransport(deps: TelegramTransportDeps): ChannelPoller {
  const createBot = deps.createBot ?? ((token: string) => new Bot(token) as unknown as BotLike);
  const runBot = deps.runBot ?? ((bot: BotLike, options: TelegramRunnerOptionsLike) => run(bot as never, options as never) as unknown as RunnerHandleLike);

  let bot: BotLike | undefined;
  let handle: RunnerHandleLike | undefined;
  let fingerprint: string | undefined;
  let stopped = true;

  const transport: ChannelPoller = {
    onError: undefined,

    async start(config: ChannelConfig): Promise<StateResult<void>> {
      return processWithLog({ operation: TELEGRAM_OPERATIONS.TRANSPORT_START, parameters: { approvedUsers: config.approvedUserIds.length } }, async () => {
      if (!stopped) {
        return { ok: false, code: "invalid", message: "Telegram connection is already running" };
      }

      const candidateFingerprint = telegramTokenFingerprint(config.token);
      if (activeTokenFingerprints.has(candidateFingerprint)) {
        return { ok: false, code: "invalid", message: "A Telegram connection is already active for this bot token" };
      }

      let candidate: BotLike;
      try {
        candidate = createBot(config.token);
      } catch (error) {
        deps.logger.warn("telegram_create_failed", { error: safeTransportError(error) });
        return { ok: false, code: "io", message: "Unable to create Telegram connection" };
      }

      candidate.catch((error) => {
        // Middleware errors must never become unhandled host rejections.
        deps.logger.warn("telegram_middleware_error", { error: safeTransportError(error) });
      });
      const currentApprovedUserIds = [...config.approvedUserIds];
      const syncCommands = async (approvedUserIds: readonly string[] = currentApprovedUserIds): Promise<void> => {
        if (!candidate.api.setMyCommands || deps.commands === undefined) return;
        const commands = typeof deps.commands === "function" ? deps.commands() : deps.commands;
        const scopes: TelegramCommandScope[] = [
          { type: "default" },
          { type: "all_private_chats" },
          ...approvedUserIds.map((chat_id) => ({ type: "chat" as const, chat_id })),
        ];
        try {
          for (const scope of scopes) {
            await candidate.api.setMyCommands(commands, { scope });
          }
          deps.logger.info("telegram_commands_synced", { count: commands.length, scopes: scopes.length });
        } catch (error) {
          deps.logger.warn("telegram_commands_sync_failed", { error: safeTransportError(error) });
        }
      };
      if (candidate.on) {
        candidate.on("message", async (context) => {
          if (telegramCommandFromContext(context)) await syncCommands(currentApprovedUserIds);
          return deps.onMessage?.(context);
        });
        if (deps.onCallbackQuery) candidate.on("callback_query", deps.onCallbackQuery);
      }

      try {
        await candidate.init();
      } catch (error) {
        // The token was rejected (e.g. 401/404 from getMe). No poller is
        // started and no ownership remains; the manager releases it.
        deps.logger.warn("telegram_startup_failed", { error: safeTransportError(error) });
        return { ok: false, code: "invalid", message: "Telegram connection rejected the configured token" };
      }

      // Publish the current menu before polling. This also clears stale
      // Telegram commands when the current catalog is empty.
      await syncCommands();

      bot = candidate;
      fingerprint = candidateFingerprint;
      activeTokenFingerprints.add(candidateFingerprint);
      stopped = false;

      try {
        handle = runBot(candidate, {
          runner: { silent: true, fetch: { allowed_updates: deps.allowedUpdates ?? ["message"] } },
        });
      } catch (error) {
        activeTokenFingerprints.delete(candidateFingerprint);
        bot = undefined;
        fingerprint = undefined;
        stopped = true;
        deps.logger.warn("telegram_polling_start_failed", { error: safeTransportError(error) });
        return { ok: false, code: "io", message: "Telegram connection failed to start polling" };
      }

      handle.task()?.then(
        () => {
          if (!stopped) {
            deps.logger.warn("telegram_polling_ended", {});
            transport.onError?.(new Error("Telegram polling ended unexpectedly"));
          }
        },
        (error) => {
          if (!stopped) {
            deps.logger.warn("telegram_polling_error", { error: safeTransportError(error) });
            transport.onError?.(error);
          }
        },
      );

      deps.logger.info("telegram_connected", {});
      return { ok: true, value: undefined };
      });
    },

    async stop(): Promise<void> {
      return processWithLog({ operation: TELEGRAM_OPERATIONS.TRANSPORT_STOP }, async () => {
      if (stopped) return;
      stopped = true;

      const currentHandle = handle;
      handle = undefined;
      if (currentHandle) {
        try {
          await currentHandle.stop();
        } catch {
          // Stop is best-effort; ownership is still released by the manager.
        }
      }

      const currentBot = bot;
      bot = undefined;
      if (currentBot) {
        try {
          await currentBot.stop();
        } catch {
          // Best-effort; the runner stop already interrupted pending fetches.
        }
      }

      if (fingerprint) {
        activeTokenFingerprints.delete(fingerprint);
        fingerprint = undefined;
      }
      deps.logger.info("telegram_stopped", {});
      });
    },
  };

  return transport;
}