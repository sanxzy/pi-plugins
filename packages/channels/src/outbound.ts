/**
 * Marker-gated outbound Telegram text delivery.
 *
 * Phase 6 sends plain text only, chunked at 4,000 characters in order, to the
 * latest accepted Telegram chat. Delivery is allowed only when the persisted
 * last-connection marker says `telegram`. A failed chunk reports explicit
 * partial delivery instead of silently truncating or blindly retrying an
 * ambiguous non-idempotent send.
 */

import { Bot } from "grammy";
import { readChannelConfig, readLastConnection } from "./state.ts";

/** Telegram text chunk limit for outbound delivery. */
export const MAX_TEXT_LENGTH = 4000;

const TOKEN_PATTERN = /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g;

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Telegram delivery failed";
  return message.replace(TOKEN_PATTERN, "[Redacted]");
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

export type OutboundTextResult =
  | { ok: true; sent: number; failed: 0 }
  | { ok: false; sent: number; failed: number; error: string };

/** Minimal grammY API surface needed to send text (injectable for tests). */
export interface TelegramSendApi {
  sendMessage(chatId: number | string, text: string, other?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Send text to a chat, chunked in order. Sends are sequential and stop at the
 * first failed chunk; the result reports how many chunks were delivered and how
 * many failed, making partial delivery explicit.
 */
export async function sendTextChunks(
  chatId: string,
  text: string,
  send: (chatId: string, chunk: string) => Promise<void>,
): Promise<OutboundTextResult> {
  const chunks = splitTextChunks(text);
  let sent = 0;
  let failed = 0;
  let firstError: string | undefined;
  for (const chunk of chunks) {
    try {
      await send(chatId, chunk);
      sent += 1;
    } catch (error) {
      failed += 1;
      firstError ??= safeError(error);
      break;
    }
  }
  if (failed > 0) {
    return { ok: false, sent, failed, error: firstError ?? "Telegram delivery failed" };
  }
  return { ok: true, sent, failed: 0 };
}

export interface TelegramOutboundOptions {
  /** Injectable send surface, defaulting to a grammY bot API obtained from the config token. */
  createSendApi?(token: string): TelegramSendApi;
  readConfig?: typeof readChannelConfig;
  readMarker?: typeof readLastConnection;
}

export interface TelegramOutbound {
  /** True only when the persisted marker says `telegram` and a chat is recorded. */
  canSend(projectRoot: string): boolean;
  /** The latest accepted Telegram chat id, or undefined when the marker is TUI/unset. */
  targetChat(projectRoot: string): string | undefined;
  /** Send text to the latest accepted Telegram chat, or fail closed. */
  send(projectRoot: string, text: string): Promise<OutboundTextResult>;
}

/** Create the marker-gated outbound sender. */
export function createTelegramOutbound(options: TelegramOutboundOptions = {}): TelegramOutbound {
  const readConfig = options.readConfig ?? readChannelConfig;
  const readMarker = options.readMarker ?? readLastConnection;

  const targetChat = (projectRoot: string): string | undefined => {
    const marker = readMarker(projectRoot);
    if (!marker.ok || marker.value.lastConnection !== "telegram") return undefined;
    return marker.value.chatRoomId;
  };

  const canSend = (projectRoot: string): boolean => targetChat(projectRoot) !== undefined;

  const send = async (projectRoot: string, text: string): Promise<OutboundTextResult> => {
    const chatId = targetChat(projectRoot);
    if (chatId === undefined) {
      return { ok: false, sent: 0, failed: 1, error: "connection_not_telegram" };
    }
    const channel = readConfig(projectRoot);
    if (!channel.ok) {
      return { ok: false, sent: 0, failed: 1, error: "Telegram channel not configured" };
    }
    const createSendApi = options.createSendApi ?? defaultCreateSendApi;
    const api = createSendApi(channel.value.token);
    return sendTextChunks(chatId, text, async (target, chunk) => {
      await api.sendMessage(target, chunk);
    });
  };

  return { canSend, targetChat, send };
}

/** Default real-grammY API surface; it never starts polling. */
function defaultCreateSendApi(token: string): TelegramSendApi {
  // The bot is used only for direct API sends; polling remains owned by the
  // project connection manager. Keeping this factory injectable makes tests
  // network-free.
  const bot = new Bot(token);
  return {
    sendMessage: (chatId, text, other) => bot.api.sendMessage(chatId, text, other),
  };
}

/** Convenience gate used by the model-callable tool. */
export function canSendTelegram(projectRoot: string): boolean {
  return createTelegramOutbound().canSend(projectRoot);
}

/** Convenience sender used by the model-callable tool. */
export function sendTelegramMessage(projectRoot: string, text: string): Promise<OutboundTextResult> {
  return createTelegramOutbound().send(projectRoot, text);
}
