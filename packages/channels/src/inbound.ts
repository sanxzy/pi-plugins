/**
 * Text-only inbound Telegram decoding and delivery.
 *
 * Phase 6 accepts only private text messages from approved identities, delivers
 * them to the root parent one follow-up at a time in FIFO order, and ignores
 * non-text, edited, and unauthorized updates. Unknown private users enter the
 * persisted DM pairing flow and never enter the parent session until approved.
 */

import { CHANNEL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import {
  readChannelConfig,
  writeChannelConfig,
  type ChannelConfig,
  type StateResult,
} from "./state.ts";
import { formatPairingChallenge, upsertPairingRequest } from "./pairing.ts";
import { resolveChannelSettings } from "./settings.ts";

/** A single accepted private text update. */
export interface TelegramUpdate {
  updateId: number;
  /** Telegram message identity used for reactions. */
  messageId?: number;
  /** Numeric chat room id, always serialized to a string. */
  chatId: string;
  /** Numeric sender id, always serialized to a string. */
  fromId: string;
  text: string;
}

/**
 * The narrow update shape the decoder reads. A real grammY `Context` exposes
 * the update at `context.update` and the message at `context.update.message`,
 * while offline tests pass a flat `{ update_id, message }` object. The decoder
 * reads both shapes so the same path works live and in tests.
 */
interface TelegramRawMessageContext {
  update_id?: unknown;
  update?: { update_id?: unknown; message?: TelegramRawMessage };
  api?: { sendMessage?: (chatId: number | string, text: string) => Promise<unknown> };
  message?: TelegramRawMessage;
}

interface TelegramRawMessage {
  chat?: { id?: number | string; type?: string };
  from?: { id?: number | string };
  text?: string;
  message_id?: number;
  edit_date?: number;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function extractUpdateId(context: unknown): unknown {
  const raw = context as TelegramRawMessageContext;
  return raw?.update_id ?? raw?.update?.update_id;
}

function isNumericId(value: unknown): value is number | string {
  return (typeof value === "number" && Number.isSafeInteger(value))
    || (typeof value === "string" && /^-?\d+$/.test(value));
}

/**
 * Decode a grammY message context into an accepted private text update.
 *
 * Returns `undefined` for anything that must not enter the parent session:
 * group/supergroup/channel chats, edited messages (identified by `edit_date`),
 * missing or non-text messages, and missing sender or update identities.
 */
export function decodeAcceptedText(context: unknown): TelegramUpdate | undefined {
  const raw = context as TelegramRawMessageContext;
  const message = raw?.message ?? raw?.update?.message;
  if (!message?.chat?.type || message.chat.type !== "private") return undefined;
  if (message.edit_date !== undefined) return undefined;
  if (typeof message.text !== "string" || message.text.trim().length === 0) return undefined;
  if (!isNumericId(message.chat.id)) return undefined;
  if (!isNumericId(message.from?.id)) return undefined;

  const updateId = raw?.update_id ?? raw?.update?.update_id;
  if (!isNumber(updateId)) return undefined;

  return {
    updateId,
    ...(isNumber(message.message_id) ? { messageId: message.message_id } : {}),
    chatId: String(message.chat.id),
    fromId: String(message.from.id),
    text: message.text,
  };
}

/**
 * Exact Telegram origin marker appended to the content of every accepted
 * Telegram follow-up. Never added to TUI-originated content.
 */
export function formatTelegramSignature(chatId: string, messageId?: number): string {
  const origin = messageId === undefined ? chatId : `${chatId}:${messageId}`;
  return `\n\n---\n[from:telegram:${origin}]\nInfo: I am currently active through Telegram. To communicate directly with me, use the telegram_chat tool.\n---`;
}

const TELEGRAM_SIGNATURE_PATTERN = /\[from:telegram:(-?\d+)(?::(\d+))?\]/g;

/** Origin metadata embedded in an accepted Telegram user message. */
export interface TelegramMessageOrigin {
  chatId: string;
  messageId?: number;
}

/** Extract the latest Telegram origin marker, including its message identity. */
export function extractTelegramMessageOrigin(text: string): TelegramMessageOrigin | undefined {
  const matches = text.matchAll(TELEGRAM_SIGNATURE_PATTERN);
  let last: RegExpMatchArray | undefined;
  for (const match of matches) last = match;
  if (!last) return undefined;
  return {
    chatId: last[1]!,
    messageId: last[2] === undefined ? undefined : Number(last[2]),
  };
}

/**
 * Compact origin marker for Telegram-dispatched commands. Commands do not
 * carry the long activity guidance (that text would split the injected
 * message into two blocks); the compact signature still names the chat so the
 * outbound gate keeps working.
 */
export function formatTelegramCommandSignature(chatId: string, messageId?: number): string {
  const origin = messageId === undefined ? chatId : `${chatId}:${messageId}`;
  return `\n\n---\n[from:telegram:${origin}]\nUser active on Telegram. Reply through the \`telegram_chat\` tool.\n---`;
}

const TELEGRAM_COMMAND_NAME_PATTERN = /^[a-z0-9_]{1,32}$/;

/** A parsed Telegram slash command. */
export interface TelegramCommand {
  name: string;
  args: string;
}

/**
 * Parse a Telegram bot command (`/name args` or `/name@BotName args`), or
 * undefined for ordinary text. Names are validated with the Bot API pattern.
 */
export function parseTelegramCommand(text: string): TelegramCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const [head, ...tail] = trimmed.split(/\s+/);
  const name = head.slice(1).split("@")[0]?.toLowerCase();
  if (!name || !TELEGRAM_COMMAND_NAME_PATTERN.test(name)) return undefined;
  return { name, args: tail.join(" ").trim() };
}

/**
 * Extract the origin chat id from a Telegram-signed user message, or undefined
 * when the text carries no signature. The signature is the authoritative
 * connection marker: the outbound gate derives the reply target from the
 * latest user message instead of a persisted file. The last occurrence wins
 * because the bridge always appends the real signature last.
 */
export function extractTelegramChatId(text: string): string | undefined {
  return extractTelegramMessageOrigin(text)?.chatId;
}

/** A queued, accepted private text message awaiting delivery. */
interface QueuedUpdate {
  updateId: number;
  chatId: string;
  text: string;
  messageId?: number;
}

export interface TelegramInboundOptions {
  /** Approved numeric sender ids read from the current channel config. */
  approvedUserIds: readonly string[];
  /** Project root used to resolve centralized pairing settings. */
  projectRoot?: string;
  /** Project config reader used to refresh approvals and persist pairing state. */
  readConfig?: () => StateResult<ChannelConfig>;
  /** Project config writer used for challenge creation/refresh. */
  writeConfig?: (config: ChannelConfig) => StateResult<void>;
  /** Send a newly-created pairing challenge back to the requesting DM. */
  onChallenge?: (context: unknown, chatId: string, text: string) => Promise<void>;
  /** Optional local boundary for pairing/delivery failures and capped requests. */
  onError?(error: unknown): void;
  /**
   * Deliver one accepted message. The exact origin signature is appended before
   * calling this callback; the callback writes the connection marker and
   * injects the follow-up.
   */
  onAccepted(updateId: number, chatId: string, text: string, messageId?: number): Promise<void>;
}

export interface TelegramInboundListener {
  /** Decode, authorize, dedupe, queue, and opportunistically drain one update. */
  handle(context: unknown): Promise<void>;
  /** Refresh approved identities when setup writes a new channel config. */
  setApprovedUserIds(userIds: readonly string[]): void;
  /** Skip every update at or below this identity (already delivered previously). */
  setLastUpdateId(updateId: number): void;
  /** Mark the agent busy (pause draining) or idle (resume draining). */
  setBusy(busy: boolean): void;
  /** Compatibility settlement hook; delivery no longer depends on permits. */
  releaseNext(): void;
  /** Drop queued Telegram items without stopping delivery (used by /stop). */
  clearQueue(): void;
  /** Drop queued state on shutdown. */
  stop(): void;
}

/**
 * Create the authorized text-only inbound path.
 *
 * Accepted updates are deduplicated by update identity and delivered in arrival
 * order. At most one update is ever in flight at a time; the caller's
 * `onAccepted` decides whether the message starts a turn (the bridge holds a
 * single active-turn guard), so the transport itself never pauses on agent
 * lifecycle. Unauthorized private updates create or refresh one persisted
 * pairing request and are never delivered.
 */
export function createTelegramInbound(options: TelegramInboundOptions): TelegramInboundListener {
  const queue: QueuedUpdate[] = [];
  const seen = new Set<number>();
  const failed = new Set<number>();
  let approvedUserIds = new Set(options.approvedUserIds);
  let lastUpdateId = -1;
  let busy = false;
  let delivering = false;

  const refreshConfig = (): ChannelConfig | undefined => {
    const result = options.readConfig?.();
    if (!result) return undefined;
    if (!result.ok) {
      options.onError?.(new Error("Unable to read Telegram pairing state"));
      return undefined;
    }
    approvedUserIds = new Set(result.value.approvedUserIds);
    return result.value;
  };

  const handleUnauthorized = async (
    context: unknown,
    update: TelegramUpdate,
    config: ChannelConfig | undefined,
  ): Promise<void> => {
    if (!config || !options.writeConfig || !options.onChallenge) return;
    const pairing = upsertPairingRequest(
      config,
      update.fromId,
      new Date(),
      undefined,
      options.projectRoot ? resolveChannelSettings(options.projectRoot) : undefined,
    );
    if (pairing.kind === "capped") {
      // Do not reveal the cap or produce Telegram chatter. The host may route
      // this safe local event to its structured channel logger.
      options.onError?.(new Error("Telegram pairing request cap reached"));
      return;
    }
    const written = options.writeConfig(pairing.config);
    if (!written.ok) {
      options.onError?.(new Error("Unable to persist Telegram pairing request"));
      return;
    }
    // Existing requests deliberately send no second challenge, even though
    // their expiry is refreshed above.
    if (pairing.kind === "created") {
      await options.onChallenge(context, update.chatId, formatPairingChallenge(pairing.request));
    }
  };

  const deliverySettled = (item: QueuedUpdate, delivered: boolean): void => {
    delivering = false;
    if (delivered) {
      failed.delete(item.updateId);
      lastUpdateId = Math.max(lastUpdateId, item.updateId);
      attemptDrain();
      return;
    }
    // Keep a failed update retryable without busy-looping. The next arrival of
    // the same update id (or an explicit release) will drain this item again.
    failed.add(item.updateId);
    seen.delete(item.updateId);
    queue.unshift(item);
  };

  const attemptDrain = (): void => {
    if (busy || delivering || queue.length === 0) return;
    const item = queue.shift()!;
    delivering = true;
    void processWithLog({
      operation: CHANNEL_OPERATIONS.INBOUND_DRAIN,
      parameters: { updateId: item.updateId, chatId: item.chatId },
    }, async () => {
      await options.onAccepted(item.updateId, item.chatId, item.text, item.messageId);
    })
      .then(() => deliverySettled(item, true))
      .catch((error: unknown) => {
        deliverySettled(item, false);
        options.onError?.(error);
      });
  };

  return {
    async handle(context: unknown): Promise<void> {
      return processWithLog({
        operation: CHANNEL_OPERATIONS.INBOUND_HANDLE,
        parameters: { updateId: extractUpdateId(context) },
      }, async () => {
        const update = decodeAcceptedText(context);
        if (update === undefined) return;
        const config = refreshConfig();
        if (!approvedUserIds.has(update.fromId)) {
          await handleUnauthorized(context, update, config);
          return;
        }
        // An update at or below the last durably persisted id is a replay. A
        // failed delivery never advances the durable cursor, so re-arrivals of
        // the same id remain eligible for retry rather than being treated as a
        // delivered replay.
        if (update.updateId < lastUpdateId || (update.updateId === lastUpdateId && !failed.has(update.updateId))) return;
        if (failed.has(update.updateId)) {
          // The failed item is already at the head of the queue; a re-arrival
          // retries it without enqueueing a duplicate payload.
          attemptDrain();
          return;
        }
        if (seen.has(update.updateId)) return;
        seen.add(update.updateId);
        queue.push({ updateId: update.updateId, chatId: update.chatId, text: update.text, messageId: update.messageId });
        attemptDrain();
      });
    },

    setApprovedUserIds(userIds: readonly string[]): void {
      approvedUserIds = new Set(userIds);
    },

    setLastUpdateId(updateId: number): void {
      lastUpdateId = Math.max(lastUpdateId, updateId);
    },

    setBusy(next: boolean): void {
      busy = next;
      if (!next) attemptDrain();
    },

    releaseNext(): void {
      // Kept for compatibility with the previous permit model, but delivery no
      // longer depends on these settlement permits. Draining is continuous and
      // serialized by the caller's single active-turn guard.
      attemptDrain();
    },

    clearQueue(): void {
      queue.length = 0;
    },

    stop(): void {
      busy = true;
      queue.length = 0;
    },
  };
}

/** Default state seams for callers that do not need project-specific injection. */
export function defaultTelegramPairingState(projectRoot: string): Pick<TelegramInboundOptions, "readConfig" | "writeConfig"> {
  return {
    readConfig: () => readChannelConfig(projectRoot),
    writeConfig: (config) => writeChannelConfig(projectRoot, config),
  };
}
