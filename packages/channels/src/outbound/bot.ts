import { Bot, type BotError } from "grammy";

export interface BotLogger {
  warn(message: string): void;
}

/**
 * Create a grammY bot with a catch boundary. The token is deliberately never
 * included in the warning; Telegram errors can contain request context.
 */
export function createBot(token: string, logger: BotLogger = console): Bot {
  const bot = new Bot(token);
  bot.catch((error: BotError) => {
    const message = error.error instanceof Error ? error.error.message : String(error.error);
    logger.warn(`Telegram middleware error: ${message}`);
  });
  return bot;
}
