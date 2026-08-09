import { randomUUID } from "node:crypto";
import { loadChannelConfig } from "../state/index.ts";
import {
  CHOICE_TTL_MS,
  choiceCallbackData,
  deleteChoice,
  registerChoice,
  validateChoices,
  type ChoiceOption,
} from "../choices/index.ts";
import { createBot } from "./bot.ts";
import { sendChoiceQuery } from "./send.ts";
import { formatTelegramSignature } from "../inbound/index.ts";
import type { ChoiceCallbackEffects, PendingChoice } from "../choices/index.ts";

export interface ChoiceSendApi {
  sendMessage(chatId: number | string, text: string, other?: Record<string, unknown>): Promise<unknown>;
  answerCallbackQuery(queryId: string, other?: { text?: string }): Promise<unknown>;
  editMessageReplyMarkup(chatId: number | string, messageId: number, other?: { reply_markup?: unknown }): Promise<unknown>;
}

export interface ChoiceBotSurface {
  api: ChoiceSendApi;
}

export interface SendChoiceOptions {
  createBot?: (token: string) => ChoiceBotSurface;
  now?: () => number;
  setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  sendFollowUp?: (content: string) => Promise<void>;
  setTelegramMarker?: () => void | Promise<void>;
}

export interface SendChoiceResult {
  ok: boolean;
  sent: number;
  error?: string;
}

function defaultBot(token: string): ChoiceBotSurface {
  return createBot(token) as unknown as ChoiceBotSurface;
}

/**
 * Send a question with an inline keyboard and register the pending choice so a
 * logged callback can inject the contextual follow-up. Returns immediately
 * without blocking the tool call.
 */
export async function sendTelegramChoice(
  projectRoot: string,
  question: string,
  options: ChoiceOption[],
  opts: SendChoiceOptions = {},
): Promise<SendChoiceResult> {
  const invalid = validateChoices(options);
  if (invalid !== undefined) return { ok: false, sent: 0, error: invalid };

  const channel = loadChannelConfig(projectRoot);
  if (channel === null) return { ok: false, sent: 0, error: "Telegram channel not configured" };

  const now = opts.now ?? Date.now;
  const timerSet = opts.setTimeout ?? setTimeout;
  const timerClear = opts.clearTimeout ?? clearTimeout;
  const id = randomUUID();
  const pending: PendingChoice = {
    id,
    question,
    options,
    defaultChatId: channel.defaultChatId,
    expiresAt: now() + CHOICE_TTL_MS,
    answered: false,
    onAnswer: async (option: ChoiceOption, effects: ChoiceCallbackEffects) => {
      await effects.removeKeyboard();
      effects.beginTyping();
      try {
        await opts.setTelegramMarker?.();
        const value = option.value ?? option.label;
        const content = `Based on your question: ${question}\nAnswer: ${value}${formatTelegramSignature(pending.defaultChatId)}`;
        await opts.sendFollowUp?.(content);
      } finally {
        effects.endTyping();
      }
    },
  };
  registerChoice(projectRoot, pending);

  const createBotSurface = opts.createBot ?? defaultBot;
  const bot = createBotSurface(channel.botToken);
  const buttons = options.map((option, index) => ({
    text: option.label,
    callback_data: choiceCallbackData(id, index),
  }));
  const result = await sendChoiceQuery(bot.api, channel.defaultChatId, question, buttons);
  if (!result.ok) {
    // The question never reached the user; do not keep a phantom pending choice.
    deleteChoice(projectRoot, id);
    return { ok: false, sent: 0, error: result.error };
  }
  // Auto-expire: disable the keyboard and drop the pending state after the TTL
  // even if no callback ever arrives.
  const expiryTimer = timerSet(() => {
    // Telegram leaves inline keyboards active until explicitly edited; clear it
    // before dropping the local correlation state when no callback arrives.
    if (result.messageId !== undefined) {
      void bot.api.editMessageReplyMarkup(channel.defaultChatId, result.messageId, {
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {
        // Expiry cleanup is best-effort; the pending state is still discarded.
      });
    }
    deleteChoice(projectRoot, id);
  }, CHOICE_TTL_MS);
  pending.onExpire = () => {
    timerClear(expiryTimer);
  };
  return { ok: true, sent: result.sent };
}

export interface ChoicePending {
  id: string;
}