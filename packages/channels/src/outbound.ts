/**
 * Outbound Telegram text delivery keyed by an explicit chat id.
 *
 * The caller resolves the reply target (from the latest Telegram-signed user
 * message) and passes it in; the sender itself no longer reads a persisted
 * connection marker. Delivery sends plain text only, chunked at 4,000
 * characters in order. A failed chunk reports explicit partial delivery
 * instead of silently truncating or blindly retrying an ambiguous
 * non-idempotent send.
 */

import { Bot } from "grammy";
import { readChannelConfig } from "./state.ts";

/** Telegram text chunk limit for outbound delivery. */
export const MAX_TEXT_LENGTH = 4000;

export type TelegramTextFormat = "plain" | "html" | "markdown_v2";

export interface TelegramChoiceButton {
  label: string;
  callbackData: string;
}

export type OutboundChoiceResult =
  | { ok: true; messageId: number; expiresAt: number }
  | { ok: false; error: string; category: OutboundErrorCategory };

export interface TelegramSendTextOptions {
  /** Explicit presentation format. Plain is the default. */
  format?: TelegramTextFormat;
  /** When supplied, deliver as a Telegram reply to this message id. */
  messageId?: number;
  /** Telegram link-preview overrides, passed only when requested. */
  linkPreviewOptions?: Record<string, unknown>;
  /** Suppress the notification for this message when explicitly requested. */
  disableNotification?: boolean;
}

const TOKEN_PATTERN = /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g;

/** Standard Telegram emoji reactions the model may request. */
export const STANDARD_REACTIONS: ReadonlySet<string> = new Set([
  "👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬",
  "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🥱", "🥴", "😍", "🌚",
  "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾",
  "💋", "😈", "😴", "😭", "🤓", "👻", "👀", "🎃", "🙈", "😇", "😨",
  "🤝", "✍", "🤗", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘",
  "😎", "👾", "🤷", "😡",
]);

/** True only for a standard emoji in the allowlist. */
export function validateStandardReaction(emoji: string): boolean {
  return typeof emoji === "string" && emoji.length > 0 && STANDARD_REACTIONS.has(emoji);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Telegram delivery failed";
  return message.replace(TOKEN_PATTERN, "[Redacted]");
}

function outboundErrorCategory(error: unknown): OutboundErrorCategory {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { error_code?: unknown; code?: unknown };
    if (candidate.error_code === 429) return "rate_limited";
    if (candidate.code === "ETIMEDOUT" || candidate.code === "ECONNRESET") return "network_error";
  }
  return "partial_delivery";
}

/**
 * Split text into consecutive ordered chunks, each at most `MAX_TEXT_LENGTH`.
 * Prefers a line or space boundary inside the limit; unbroken text is hard split
 * so no chunk ever exceeds the limit and no content is dropped.
 */
export function splitTextChunks(text: string): string[] {
  if (text.length <= MAX_TEXT_LENGTH) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > MAX_TEXT_LENGTH) {
    let cut = rest.lastIndexOf("\n", MAX_TEXT_LENGTH - 1);
    if (cut < 1) cut = rest.lastIndexOf(" ", MAX_TEXT_LENGTH - 1);
    if (cut < 1) cut = MAX_TEXT_LENGTH;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/** Stable, categorized outbound failure codes exposed to the model. */
export type OutboundErrorCategory =
  | "rate_limited"
  | "network_error"
  | "telegram_rejected"
  | "partial_delivery"
  | "not_configured"
  | "target_not_approved";

export type TelegramTargetValidation =
  | { ok: true; chatId: string }
  | { ok: false; category: "not_configured" | "target_not_approved"; error: string };

const PRIVATE_CHAT_ID_PATTERN = /^\d+$/;

/** Validate an explicit destination against the configured approved private chats. */
export function validateTelegramTarget(
  projectRoot: string,
  chatId: string,
  readConfig: typeof readChannelConfig = readChannelConfig,
): TelegramTargetValidation {
  if (typeof chatId !== "string" || !PRIVATE_CHAT_ID_PATTERN.test(chatId)) {
    return { ok: false, category: "target_not_approved", error: "Telegram target is not an approved private chat" };
  }
  const channel = readConfig(projectRoot);
  if (!channel.ok) {
    return { ok: false, category: "not_configured", error: "Telegram channel not configured" };
  }
  if (!channel.value.approvedUserIds.includes(chatId)) {
    return { ok: false, category: "target_not_approved", error: "Telegram target is not an approved private chat" };
  }
  return { ok: true, chatId };
}

/**
 * Outbound delivery result. Success carries the Telegram message ids of every
 * delivered chunk; failure carries a stable category and a redacted error.
 */
export type OutboundTextResult =
  | { ok: true; sent: number; failed: 0; messageIds: number[] }
  | { ok: false; sent: number; failed: number; error: string; category: OutboundErrorCategory };

/** Minimal grammY API surface needed to send text (injectable for tests). */
export interface TelegramSendApi {
  sendMessage(chatId: number | string, text: string, other?: Record<string, unknown>): Promise<unknown>;
  setMessageReaction?(chatId: number | string, messageId: number, reaction: unknown, other?: Record<string, unknown>): Promise<unknown>;
  sendChatAction?(chatId: number | string, action: string): Promise<unknown>;
  answerCallbackQuery?(callbackQueryId: string): Promise<unknown>;
  editMessageReplyMarkup?(chatId: number | string, messageId: number, other?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Send text to a chat, chunked in order. Sends are sequential and stop at the
 * first failed chunk; the result reports how many chunks were delivered and how
 * many failed, making partial delivery explicit.
 */
export async function sendTextChunks(
  chatId: string,
  text: string,
  send: (chatId: string, chunk: string) => Promise<number | undefined | void>,
): Promise<OutboundTextResult> {
  const chunks = splitTextChunks(text);
  const sentIds: number[] = [];
  let sent = 0;
  let failed = 0;
  let firstError: string | undefined;
  let firstRawError: unknown;
  for (const chunk of chunks) {
    try {
      const messageId = await send(chatId, chunk);
      sent += 1;
      if (typeof messageId === "number") sentIds.push(messageId);
    } catch (error) {
      failed += 1;
      firstError ??= safeError(error);
      firstRawError ??= error;
      break;
    }
  }
  if (failed > 0) {
    return {
      ok: false,
      sent,
      failed,
      error: firstError ?? "Telegram delivery failed",
      category: outboundErrorCategory(firstRawError),
    };
  }
  return { ok: true, sent, failed: 0, messageIds: sentIds };
}

export interface TelegramOutboundOptions {
  /** Injectable send surface, defaulting to a grammY bot API obtained from the config token. */
  createSendApi?(token: string): TelegramSendApi;
  readConfig?: typeof readChannelConfig;
  /** Injectable delay seam for bounded retry tests. */
  sleep?(milliseconds: number): Promise<void>;
}

export interface TelegramOutbound {
  /** Send text to a specific Telegram chat, or fail closed when not configured. */
  send(projectRoot: string, chatId: string, text: string, options?: TelegramSendTextOptions): Promise<OutboundTextResult>;
  /** React to a specific Telegram message, or fail closed when not configured. */
  react(projectRoot: string, chatId: string, messageId: number, reaction: unknown): Promise<OutboundTextResult>;
  /** Send a question with an inline keyboard to an approved chat. */
  sendChoices(projectRoot: string, chatId: string, question: string, buttons: TelegramChoiceButton[], replyToMessageId?: number): Promise<OutboundChoiceResult>;
}

/** Create the outbound sender. The reply chat id is supplied by the caller. */
export function createTelegramOutbound(options: TelegramOutboundOptions = {}): TelegramOutbound {
  const readConfig = options.readConfig ?? readChannelConfig;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  const withConfig = async <T>(projectRoot: string, run: (api: TelegramSendApi, token: string) => Promise<T>): Promise<OutboundTextResult | T> => {
    const channel = readConfig(projectRoot);
    if (!channel.ok) {
      return { ok: false, sent: 0, failed: 1, error: "Telegram channel not configured", category: "not_configured" };
    }
    const createSendApi = options.createSendApi ?? defaultCreateSendApi;
    const api = createSendApi(channel.value.token);
    return run(api, channel.value.token);
  };

  const send = async (projectRoot: string, chatId: string, text: string, options: TelegramSendTextOptions = {}): Promise<OutboundTextResult> => {
    const target = validateTelegramTarget(projectRoot, chatId, readConfig);
    if (!target.ok) return { ok: false, sent: 0, failed: 1, error: target.error, category: target.category };
    const format = options.format ?? "plain";
    const chunks = containerizeText(text, format);
    if (chunks === undefined) {
      return { ok: false, sent: 0, failed: 1, error: "Formatted text cannot be split safely within the message limit", category: "telegram_rejected" };
    }
    const result = await withConfig(projectRoot, async (api) => {
      if (api.sendChatAction) {
        try {
          await api.sendChatAction(target.chatId, "typing");
        } catch {
          // Best-effort typing status; a failure must not block delivery.
        }
      }
      return sendTextChunks(target.chatId, text, async (destination, chunk) => {
        const sentMessage = await attemptSend(api, destination, chunk, {
          format,
          messageId: options.messageId,
          linkPreviewOptions: options.linkPreviewOptions,
          disableNotification: options.disableNotification,
          sleep,
        });
        return readMessageId(sentMessage);
      });
    });
    return result as OutboundTextResult;
  };

  const react = async (projectRoot: string, chatId: string, messageId: number, reaction: unknown): Promise<OutboundTextResult> => {
    const target = validateTelegramTarget(projectRoot, chatId, readConfig);
    if (!target.ok) return { ok: false, sent: 0, failed: 1, error: target.error, category: target.category };
    const result = await withConfig(projectRoot, async (api) => {
      if (!api.setMessageReaction) return { ok: false as const, sent: 0, failed: 1, error: "Telegram reaction API is unavailable", category: "telegram_rejected" as const };
      try {
        await api.setMessageReaction(chatId, messageId, reaction);
        return { ok: true as const, sent: 1, failed: 0, messageIds: [messageId] };
      } catch (error) {
        return { ok: false as const, sent: 0, failed: 1, error: safeError(error), category: "telegram_rejected" as const };
      }
    });
    return result as OutboundTextResult;
  };

  const sendChoices = async (projectRoot: string, chatId: string, question: string, buttons: TelegramChoiceButton[], replyToMessageId?: number): Promise<OutboundChoiceResult> => {
    const target = validateTelegramTarget(projectRoot, chatId, readConfig);
    if (!target.ok) return { ok: false, error: target.error, category: target.category };
    const expiresAt = Date.now() + 10 * 60 * 1000;
    const result = await withConfig(projectRoot, async (api) => {
      try {
        const other: Record<string, unknown> = {
          reply_markup: { inline_keyboard: [buttons.map((button) => ({ text: button.label, callback_data: button.callbackData }))] },
        };
        if (replyToMessageId !== undefined) other.reply_parameters = { message_id: replyToMessageId };
        const sent = await api.sendMessage(target.chatId, question, other);
        const messageId = readMessageId(sent);
        if (messageId === undefined) return { ok: false as const, error: "Telegram did not return a choice message id", category: "telegram_rejected" as const };
        return { ok: true as const, messageId, expiresAt };
      } catch (error) {
        return { ok: false as const, error: safeError(error), category: "telegram_rejected" as const };
      }
    });
    return result as OutboundChoiceResult;
  };

  return { send, react, sendChoices };
}

/**
 * Bounded, idempotence-safe retry for a single text chunk. Telegram 429 flood
 * waits are retried at most once. Network errors from sendMessage are treated
 * as ambiguous non-idempotent outcomes and are surfaced immediately so no
 * duplicate message is created.
 */
async function attemptSend(
  api: TelegramSendApi,
  chatId: number | string,
  text: string,
  options: Required<Pick<TelegramSendTextOptions, "format">> &
    Pick<TelegramSendTextOptions, "messageId" | "linkPreviewOptions" | "disableNotification"> &
    { sleep: (milliseconds: number) => Promise<void> },
): Promise<unknown> {
  const other: Record<string, unknown> = {};
  if (options.format !== "plain") other.parse_mode = options.format === "html" ? "HTML" : "MarkdownV2";
  if (options.messageId !== undefined) other.reply_parameters = { message_id: options.messageId };
  if (options.linkPreviewOptions !== undefined) other.link_preview_options = options.linkPreviewOptions;
  if (options.disableNotification !== undefined) other.disable_notification = options.disableNotification;
  try {
    return await api.sendMessage(chatId, text, other);
  } catch (error) {
    const decision = classifyRetry(error);
    if (decision.kind === "retry") {
      await options.sleep(decision.delayMs);
      return api.sendMessage(chatId, text, other);
    }
    throw error;
  }
}

type RetryDecision =
  | { kind: "retry"; delayMs: number }
  | { kind: "abort" };

function classifyRetry(error: unknown): RetryDecision {
  if (typeof error === "object" && error !== null) {
    const err = error as { error_code?: unknown; parameters?: { retry_after?: unknown } };
    if (err.error_code === 429) {
      const retryAfter = err.parameters?.retry_after;
      if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
        return { kind: "retry", delayMs: Math.min(1000 * Math.max(0, retryAfter), 5000) };
      }
    }
  }
  return { kind: "abort" };
}

/**
 * Format-aware chunking. Plain text keeps the existing boundary-aware split.
 * A formatted message is returned as a single chunk when it fits, and is
 * rejected (undefined) when it exceeds the limit, because splitting markup
 * could silently produce invalid entities.
 */
function containerizeText(text: string, format: TelegramTextFormat): string[] | undefined {
  if (format === "plain") return splitTextChunks(text);
  return text.length <= MAX_TEXT_LENGTH ? [text] : undefined;
}

/** Extract a Telegram message id from an API response object, if present. */
function readMessageId(sent: unknown): number | undefined {
  if (typeof sent !== "object" || sent === null) return undefined;
  const value = (sent as { message_id?: unknown }).message_id;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/** Default real-grammY API surface; it never starts polling. */
function defaultCreateSendApi(token: string): TelegramSendApi {
  // The bot is used only for direct API sends; polling remains owned by the
  // project connection manager. Keeping this factory injectable makes tests
  // network-free.
  const bot = new Bot(token);
  return {
    sendMessage: (chatId, text, other) => bot.api.sendMessage(chatId, text, other),
    sendChatAction: (chatId, action) => bot.api.sendChatAction(chatId, action as never),
    setMessageReaction: (chatId, messageId, reaction, other) =>
      bot.api.setMessageReaction(chatId, messageId, reaction as never, other),
  };
}

/** Convenience sender used by the model-callable tool. */
export function sendTelegramMessage(projectRoot: string, chatId: string, text: string, options?: TelegramSendTextOptions): Promise<OutboundTextResult> {
  return createTelegramOutbound().send(projectRoot, chatId, text, options);
}

/** Convenience reaction helper used by the model-callable tool. */
export function reactToMessage(projectRoot: string, chatId: string, messageId: number, emoji: string): Promise<OutboundTextResult> {
  if (!validateStandardReaction(emoji)) {
    return Promise.resolve({ ok: false, sent: 0, failed: 1, error: "Unsupported reaction", category: "telegram_rejected" });
  }
  return createTelegramOutbound().react(projectRoot, chatId, messageId, [{ type: "emoji", emoji }]);
}
