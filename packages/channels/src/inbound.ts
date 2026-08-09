/**
 * Text-only inbound Telegram decoding and delivery.
 *
 * Phase 6 accepts only private text messages from approved identities, delivers
 * them to the root parent one follow-up at a time in FIFO order, and ignores
 * non-text, edited, and unauthorized updates. Unknown private users enter the
 * persisted DM pairing flow and never enter the parent session until approved.
 */

import {
  readChannelConfig,
  writeChannelConfig,
  type ChannelConfig,
  type StateResult,
} from "./state.ts";
import { formatPairingChallenge, upsertPairingRequest } from "./pairing.ts";

/** A single accepted private text update. */
export interface TelegramUpdate {
  updateId: number;
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
  edit_date?: number;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
    chatId: String(message.chat.id),
    fromId: String(message.from.id),
    text: message.text,
  };
}

/**
 * Exact Telegram origin marker appended to the content of every accepted
 * Telegram follow-up. Never added to TUI-originated content.
 */
export function formatTelegramSignature(chatId: string): string {
  return `\n\n---\n[from:telegram:${chatId}]\n---`;
}

/** A queued, accepted private text message awaiting delivery. */
interface QueuedUpdate {
  updateId: number;
  chatId: string;
  text: string;
}

export interface TelegramInboundOptions {
  /** Approved numeric sender ids read from the current channel config. */
  approvedUserIds: readonly string[];
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
  onAccepted(updateId: number, chatId: string, text: string): Promise<void>;
}

export interface TelegramInboundListener {
  /** Decode, authorize, dedupe, queue, and opportunistically drain one update. */
  handle(context: unknown): Promise<void>;
  /** Refresh approved identities when setup writes a new channel config. */
  setApprovedUserIds(userIds: readonly string[]): void;
  /** Skip every update at or below this identity (already delivered previously). */
  setLastUpdateId(updateId: number): void;
  /** Mark the root turn busy (queue) or idle (drain the next queued follow-up). */
  setBusy(busy: boolean): void;
  /** Drain the next queued follow-up after a turn settles. */
  releaseNext(): void;
  /** Drop queued state on shutdown. */
  stop(): void;
}

/**
 * Create the authorized text-only inbound path.
 *
 * Accepted updates are deduplicated by update identity and queued in arrival
 * order. At most one follow-up is ever in flight: while the root turn is busy
 * or a delivery is outstanding, further accepted updates queue; `setBusy(false)`
 * or `releaseNext` drains exactly one. Unauthorized private updates create or
 * refresh one persisted pairing request and are never delivered.
 */
export function createTelegramInbound(options: TelegramInboundOptions): TelegramInboundListener {
  const queue: QueuedUpdate[] = [];
  const seen = new Set<number>();
  let approvedUserIds = new Set(options.approvedUserIds);
  let lastUpdateId = -1;
  let busy = false;
  let delivering = false;
  // One initial delivery is allowed immediately; every later delivery requires
  // an explicit root-turn settlement/release permit.
  let permits = 1;

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
    const pairing = upsertPairingRequest(config, update.fromId);
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

  const deliverySettled = (): void => {
    delivering = false;
    // A permit granted while a delivery was in flight (e.g. by releaseNext
    // landing during the same turn) is consumed now, so a queued follow-up
    // never stalls behind an already-completed delivery.
    attemptDrain();
  };

  const attemptDrain = (): void => {
    if (busy || delivering || permits <= 0 || queue.length === 0) return;
    const item = queue.shift()!;
    permits -= 1;
    delivering = true;
    Promise.resolve()
      .then(() => options.onAccepted(item.updateId, item.chatId, item.text))
      .then(deliverySettled)
      .catch((error: unknown) => {
        deliverySettled();
        options.onError?.(error);
      });
  };

  return {
    async handle(context: unknown): Promise<void> {
      const update = decodeAcceptedText(context);
      if (update === undefined) return;
      const config = refreshConfig();
      if (!approvedUserIds.has(update.fromId)) {
        await handleUnauthorized(context, update, config);
        return;
      }
      if (update.updateId <= lastUpdateId || seen.has(update.updateId)) return;
      seen.add(update.updateId);
      lastUpdateId = Math.max(lastUpdateId, update.updateId);
      queue.push({ updateId: update.updateId, chatId: update.chatId, text: update.text });
      attemptDrain();
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
      // Always retain the settlement permit. The host may settle the turn while
      // the follow-up callback is still unwinding; dropping the permit here
      // leaves queued Telegram messages permanently stuck.
      permits += 1;
      attemptDrain();
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
