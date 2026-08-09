/**
 * Text-only inbound Telegram decoding and delivery.
 *
 * Phase 6 accepts only private text messages from approved identities, delivers
 * them to the root parent one follow-up at a time in FIFO order, and ignores
 * non-text, edited, and unauthorized updates. The decoder is pure and
 * side-effect free so offline tests drive it without a live token or network.
 */

/** A single accepted private text update. */
export interface TelegramUpdate {
  updateId: number;
  /** Numeric chat room id, always serialized to a string. */
  chatId: string;
  /** Numeric sender id, always serialized to a string. */
  fromId: string;
  text: string;
}

interface TelegramRawMessageContext {
  update_id?: unknown;
  message?: {
    chat?: { id?: number | string; type?: string };
    from?: { id?: number | string };
    text?: string;
    edit_date?: number;
  };
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Decode a grammY message context into an accepted private text update.
 *
 * Returns `undefined` for anything that must not enter the parent session:
 * group/supergroup/channel chats, edited messages (identified by `edit_date`),
 * missing or non-text messages, and missing sender or update identities.
 */
export function decodeAcceptedText(context: unknown): TelegramUpdate | undefined {
  const message = (context as TelegramRawMessageContext)?.message;
  if (!message?.chat?.type || message.chat.type !== "private") return undefined;
  if (message.edit_date !== undefined) return undefined;
  if (typeof message.text !== "string" || message.text.trim().length === 0) return undefined;
  if (message.chat.id === undefined || message.chat.id === null) return undefined;
  if (message.from?.id === undefined || message.from.id === null) return undefined;

  const updateId = (context as TelegramRawMessageContext).update_id;
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
  /**
   * Deliver one accepted message. The exact origin signature is appended before
   * calling this callback; the callback writes the connection marker and
   * injects the follow-up.
   */
  onAccepted(updateId: number, chatId: string, text: string): Promise<void>;
  /** Optional local boundary for delivery failures. */
  onError?(error: unknown): void;
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
 * or `releaseNext` drains exactly one. Unauthorized and undecodable updates are
 * silently ignored.
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

  const attemptDrain = (): void => {
    if (busy || delivering || permits <= 0 || queue.length === 0) return;
    const item = queue.shift()!;
    permits -= 1;
    delivering = true;
    Promise.resolve()
      .then(() => options.onAccepted(item.updateId, item.chatId, item.text))
      .then(() => {
        delivering = false;
      })
      .catch((error: unknown) => {
        delivering = false;
        options.onError?.(error);
      });
  };

  return {
    async handle(context: unknown): Promise<void> {
      const update = decodeAcceptedText(context);
      if (update === undefined) return;
      if (update.updateId <= lastUpdateId || seen.has(update.updateId)) return;
      if (!approvedUserIds.has(update.fromId)) return;
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
      if (delivering) return;
      permits += 1;
      attemptDrain();
    },

    stop(): void {
      busy = true;
      queue.length = 0;
    },
  };
}