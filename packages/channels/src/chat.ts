/**
 * Channel-agnostic chat capabilities used by model-facing channel tools.
 *
 * Concrete transports (Telegram today, other channels later) adapt their
 * native APIs to this small port. The registry keeps tool orchestration
 * independent from any one channel implementation.
 */

export interface ChannelTarget {
  targetId: string;
}

export type ChannelTargetValidation =
  | ({ ok: true } & ChannelTarget)
  | { ok: false; category: string; error: string };

export type ChannelTextResult =
  | { ok: true; sent: number; failed: 0; messageIds: number[] }
  | { ok: false; sent: number; failed: number; error: string; category: string };

export type ChannelReactionResult = ChannelTextResult;

export type ChannelChoiceResult =
  | { ok: true; messageId: number; expiresAt: number }
  | { ok: false; error: string; category: string };

export type ChannelMediaResult =
  | { ok: true; messageId: number; mediaType: string; bytes: number; filename?: string }
  | { ok: false; error: string; category: string };

export interface ChannelChatAdapter {
  /** Stable lowercase channel identifier used by tool input. */
  readonly id: string;
  /** Human-readable channel label used in tool responses and UI. */
  readonly label: string;
  validateTarget(projectRoot: string, targetId: string): Promise<ChannelTargetValidation>;
  sendText(
    projectRoot: string,
    targetId: string,
    text: string,
    options?: Record<string, unknown>,
  ): Promise<ChannelTextResult>;
  react(projectRoot: string, targetId: string, messageId: number, emoji: string): Promise<ChannelReactionResult>;
  sendChoices(
    projectRoot: string,
    targetId: string,
    question: string,
    choices: readonly { label: string; value: string }[],
    replyToMessageId?: number,
    sessionId?: string,
  ): Promise<ChannelChoiceResult>;
  sendMedia(
    projectRoot: string,
    targetId: string,
    mediaType: string,
    source: unknown,
    options?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<ChannelMediaResult>;
}

export interface ChannelChatRegistry {
  register(adapter: ChannelChatAdapter): void;
  unregister(channelId: string): void;
  get(channelId: string): ChannelChatAdapter | undefined;
  list(): readonly ChannelChatAdapter[];
}

/** Create an isolated adapter registry for one composition root. */
export function createChannelChatRegistry(
  adapters: readonly ChannelChatAdapter[] = [],
): ChannelChatRegistry {
  const entries = new Map<string, ChannelChatAdapter>();
  const registry: ChannelChatRegistry = {
    register(adapter) {
      const id = adapter.id.trim().toLowerCase();
      if (!id) throw new Error("Channel adapter id must not be empty");
      entries.set(id, adapter);
    },
    unregister(channelId) {
      entries.delete(channelId.trim().toLowerCase());
    },
    get(channelId) {
      return entries.get(channelId.trim().toLowerCase());
    },
    list() {
      return [...entries.values()];
    },
  };
  for (const adapter of adapters) registry.register(adapter);
  return registry;
}

const CHANNEL_CHAT_REGISTRY_KEY = Symbol.for("@xzy-ai/pi-code:channel-chat-registry");

/**
 * Process-wide adapter registry shared by every channel tool registration.
 * Channel adapters self-register here so tool orchestration stays
 * channel-agnostic and future channels slot in without touching the core.
 */
export function getGlobalChannelChatRegistry(): ChannelChatRegistry {
  const global = globalThis as unknown as Record<symbol, ChannelChatRegistry | undefined>;
  global[CHANNEL_CHAT_REGISTRY_KEY] ??= createChannelChatRegistry();
  return global[CHANNEL_CHAT_REGISTRY_KEY] as ChannelChatRegistry;
}

/** Test isolation seam for the shared channel registry. */
export function clearGlobalChannelChatRegistry(): void {
  const global = globalThis as unknown as Record<symbol, ChannelChatRegistry | undefined>;
  global[CHANNEL_CHAT_REGISTRY_KEY] = undefined;
}
