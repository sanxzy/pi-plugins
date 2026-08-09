import { loadChannelConfig, loadConnectionMarker } from "../state/index.ts";
import { createBot } from "./bot.ts";
import { sendTextChunks, type BotSendSurface, type OutboundTextResult } from "./send.ts";

export type { OutboundTextResult } from "./send.ts";

export interface CreateBotFactory {
  createBot(token: string): BotSendSurface;
}

function defaultCreateBotSurface(token: string): BotSendSurface {
  return createBot(token);
}

/**
 * True only when the fresh connection marker says `telegram`. Missing or
 * malformed markers fail safe to false, blocking Telegram delivery.
 */
export function canSendTelegram(projectRoot: string): boolean {
  const marker = loadConnectionMarker(projectRoot);
  return marker !== null && marker.lastConnection === "telegram";
}

export interface SendOptions {
  /** Supply a bot surface factory to verify the seam without network. */
  createBot?: (token: string) => BotSendSurface;
}

/**
 * Send text to the configured default chat. Requires a valid channel config;
 * otherwise returns a clear failure without creating a bot. The marker is not
 * re-checked here — callers gate via `canSendTelegram`.
 */
export async function sendTelegramMessage(
  projectRoot: string,
  text: string,
  options: SendOptions = {},
): Promise<OutboundTextResult> {
  const channel = loadChannelConfig(projectRoot);
  if (channel === null) {
    return { ok: false, sent: 0, failed: 1, error: "Telegram channel not configured" };
  }
  const createBotSurface = options.createBot ?? defaultCreateBotSurface;
  const bot = createBotSurface(channel.botToken);
  return sendTextChunks(channel.defaultChatId, text, {
    sendText: async (chatId, chunkText) => {
      await bot.api.sendMessage(chatId, chunkText);
    },
    sleep: async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
  });
}