import { Bot } from "grammy";
import { run } from "@grammyjs/runner";
import type { ChannelLogger } from "./logger.ts";
import type { ChannelPoller } from "./manager.ts";
import type { ChannelConfig, StateResult } from "./state.ts";

/**
 * Minimal structural contracts for the grammY polling surface. The real grammY
 * `Bot` and `@grammyjs/runner` handle satisfy these structurally, while tests
 * inject fakes so no live Telegram network is touched.
 */
export interface BotApiLike {
  getMe(): Promise<unknown>;
  sendMessage?(chatId: number | string, text: string, other?: Record<string, unknown>): Promise<unknown>;
}

export type TelegramMessageHandler = (context: unknown) => Promise<unknown> | unknown;

export interface BotLike {
  readonly api: BotApiLike;
  on?(event: "message", middleware: TelegramMessageHandler): void;
  init(signal?: AbortSignal): Promise<void>;
  catch(handler: (error: unknown) => unknown): void;
  stop(): Promise<void>;
}

export interface RunnerHandleLike {
  stop(): Promise<void>;
  isRunning(): boolean;
  task(): Promise<void> | undefined;
}

export type TelegramBotFactory = (token: string) => BotLike;
export type TelegramRunnerFactory = (bot: BotLike) => RunnerHandleLike;

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
export function createTelegramTransport(deps: TelegramTransportDeps): ChannelPoller {
  const createBot = deps.createBot ?? ((token: string) => new Bot(token) as unknown as BotLike);
  const runBot = deps.runBot ?? ((bot: BotLike) => run(bot as never, { runner: { silent: true } }) as unknown as RunnerHandleLike);

  let bot: BotLike | undefined;
  let handle: RunnerHandleLike | undefined;
  let fingerprint: string | undefined;
  let stopped = true;

  const transport: ChannelPoller = {
    onError: undefined,

    async start(config: ChannelConfig): Promise<StateResult<void>> {
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
      if (deps.onMessage && candidate.on) {
        candidate.on("message", deps.onMessage);
      }

      try {
        await candidate.init();
      } catch (error) {
        // The token was rejected (e.g. 401/404 from getMe). No poller is
        // started and no ownership remains; the manager releases it.
        deps.logger.warn("telegram_startup_failed", { error: safeTransportError(error) });
        return { ok: false, code: "invalid", message: "Telegram connection rejected the configured token" };
      }

      bot = candidate;
      fingerprint = candidateFingerprint;
      activeTokenFingerprints.add(candidateFingerprint);
      stopped = false;

      try {
        handle = runBot(candidate);
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
    },

    async stop(): Promise<void> {
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
    },
  };

  return transport;
}