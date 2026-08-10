/**
 * In-memory single-use Telegram choice state.
 *
 * Each `send_choices` call registers an opaque per-option callback token bound
 * to the project root, root session, approved chat, intended sender, the
 * original question, expiry, and the selected value. A valid intended-user tap
 * consumes the token atomically and returns the contextual payload; everything
 * else (expired, wrong target, duplicate, malformed) yields nothing and leaves
 * no usable interaction.
 */

export interface TelegramChoice {
  label: string;
  value: string;
}

/** A single pending choice option bound to its interaction context. */
interface PendingChoice {
  projectRoot: string;
  sessionId: string;
  chatId: string;
  senderId: string;
  question: string;
  value: string;
  expiresAt: number;
}

export interface TelegramChoiceCreateInput {
  projectRoot: string;
  sessionId: string;
  chatId: string;
  senderId: string;
  question: string;
  choices: TelegramChoice[];
  expiresAt: number;
}

export interface TelegramChoiceCreateResult {
  /** Opaque callback_data per option, in the same order as `choices`. */
  callbackData: string[];
}

export interface TelegramChoiceConsumeInput {
  projectRoot: string;
  sessionId: string;
  chatId: string;
  senderId: string;
}

export interface TelegramChoiceConsumed {
  question: string;
  value: string;
}

const pendingByToken = new Map<string, PendingChoice>();

function randomToken(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Register a choice interaction and return opaque per-option callback data. */
export function createTelegramChoice(input: TelegramChoiceCreateInput): TelegramChoiceCreateResult {
  return {
    callbackData: input.choices.map((choice, index) => {
      const token = `tc_${randomToken()}_${index}`;
      pendingByToken.set(token, {
        projectRoot: input.projectRoot,
        sessionId: input.sessionId,
        chatId: input.chatId,
        senderId: input.senderId,
        question: input.question,
        value: choice.value,
        expiresAt: input.expiresAt,
      });
      return token;
    }),
  };
}

/**
 * Atomically consume a callback token for a matching intended user/root/chat.
 * Returns the contextual payload once, then deletes the token so a duplicate or
 * late tap cannot create a second agent turn.
 */
export function consumeTelegramChoice(
  token: string,
  input: TelegramChoiceConsumeInput,
): TelegramChoiceConsumed | undefined {
  const pending = pendingByToken.get(token);
  if (!pending) return undefined;
  if (pending.projectRoot !== input.projectRoot
    || pending.sessionId !== input.sessionId
    || pending.chatId !== input.chatId
    || pending.senderId !== input.senderId) {
    return undefined;
  }
  if (pending.expiresAt < Date.now()) {
    pendingByToken.delete(token);
    return undefined;
  }
  pendingByToken.delete(token);
  return { question: pending.question, value: pending.value };
}

/** Drop all pending choice state (test isolation and process restart). */
export function clearTelegramChoiceState(): void {
  pendingByToken.clear();
}