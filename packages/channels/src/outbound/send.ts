import { GrammyError } from "grammy";

/** Telegram's hard limit on a single text message. */
export const MAX_TEXT_LENGTH = 4096;

/** Total attempts per chunk: initial send plus two retries. */
export const MAX_ATTEMPTS = 3;

/** Short backoff between retries, in milliseconds. */
export const BACKOFF_MS = [1000, 2000];

/**
 * Split text into consecutive messages at paragraph/line boundaries, each
 * within Telegram's 4096-character limit. A line without any break is hard
 * split at the limit so no chunk ever exceeds it.
 */
export function splitTextChunks(text: string): string[] {
  if (text.length <= MAX_TEXT_LENGTH) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > MAX_TEXT_LENGTH) {
    // Prefer the last newline inside the limit, otherwise the last space.
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

export interface SendAdapter {
  sendText(chatId: string, text: string): Promise<unknown>;
  sleep(ms: number): Promise<void>;
}

export const noopSleep: SendAdapter["sleep"] = async () => {};

/**
 * Whether a Telegram error is permanent and must never be retried: invalid
 * token (401), chat not found or message too long (400), and a 409 conflict
 * (another poller is running for the token).
 */
export function isPermanentError(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false;
  return (
    error.error_code === 401 ||
    error.error_code === 409 ||
    error.error_code === 400
  );
}

export function isTransientError(error: unknown): boolean {
  return error instanceof GrammyError && !isPermanentError(error);
}

/** Send one chunk with up to three total attempts and short backoff. */
export async function sendChunkWithRetry(
  chatId: string,
  text: string,
  adapter: SendAdapter,
): Promise<OutboundTextResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await adapter.sendText(chatId, text);
      return { ok: true, sent: 1, failed: 0 };
    } catch (error) {
      lastError = error;
      if (isPermanentError(error) || attempt === MAX_ATTEMPTS - 1) break;
      await adapter.sleep(BACKOFF_MS[attempt] ?? 0);
    }
  }
  return {
    ok: false,
    sent: 0,
    failed: 1,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  };
}

/**
 * Send text to a chat, splitting into consecutive chunks and applying the
 * retry policy per chunk. The result reports how many chunks were delivered.
 */
export async function sendTextChunks(
  chatId: string,
  text: string,
  adapter: SendAdapter,
): Promise<OutboundTextResult> {
  const chunks = splitTextChunks(text);
  let sent = 0;
  let failed = 0;
  let firstError: string | undefined;
  for (const chunk of chunks) {
    const result = await sendChunkWithRetry(chatId, chunk, adapter);
    if (result.ok) {
      sent += result.sent;
    } else {
      failed += result.failed;
      firstError ??= result.error;
    }
  }
  if (failed > 0) {
    return { ok: false, sent, failed, error: firstError ?? "send failed" };
  }
  return { ok: true, sent, failed: 0 };
}

/** Minified surface the send path needs from a grammY bot's API. */
export interface BotSendSurface {
  api: {
    sendMessage(chatId: number | string, text: string, other?: Record<string, unknown>): Promise<unknown>;
  };
}

/**
 * Send text with a real grammY bot, using its own API surface. Used when a
 * bot instance is available; otherwise `sendTelegramMessage` builds one.
 */
export async function sendWithBot(
  bot: BotSendSurface,
  chatId: string,
  text: string,
): Promise<OutboundTextResult> {
  return sendTextChunks(chatId, text, {
    sendText: async (targetChatId, chunkText) => {
      await bot.api.sendMessage(targetChatId, chunkText);
    },
    sleep: noopSleep,
  });
}
