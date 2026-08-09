import { loadChannelConfig } from "../state/index.ts";
import { createBot } from "../outbound/bot.ts";
import { createTelegramListener, type InboundContent, type TelegramListenerBot } from "../inbound/index.ts";
import { syncTelegramCommands } from "../menu/index.ts";

/** Minimal command shape from `pi.getCommands()` (channels never imports Pi). */
export interface TelegramCommandInfo {
  name: string;
  description?: string;
}

export interface TelegramLifecycleOptions {
  projectRoot: string;
  sessionId: string;
  sendFollowUp(content: InboundContent, options: { deliverAs: "followUp" }): Promise<void>;
  setTelegramMarker(): void | Promise<void>;
  /** Injectable bot factory so tests verify the seam without network. */
  createBot?: (token: string) => TelegramListenerBot;
  /** Optional warning boundary for startup/menu failures. */
  warn?: (message: string) => void;
}

export interface TelegramLifecycle {
  /**
   * Start (or restart) the Telegram listener with the supplied command list.
   *
   * Reads the fresh channel config, stops any previous listener so only one
   * poller ever runs for the token, and starts long polling. The command list
   * is retained for menu sync (Phase 6) and must be passed by the caller.
   * Unconfigured projects start no listener.
   */
  start(commands: readonly TelegramCommandInfo[]): Promise<void>;
  /** Stop the shared typing loop (e.g. on root settlement) without polling. */
  stopTyping(): void;
  /** Stop the listener and its typing loop. */
  stop(): Promise<void>;
}

function realBot(token: string): TelegramListenerBot {
  const bot = createBot(token);
  return {
    on: (event, middleware) => bot.on(event, middleware),
    api: {
      getFile: (fileId) => bot.api.getFile(fileId),
      sendChatAction: (chatId, action) => bot.api.sendChatAction(chatId, action),
      setMyCommands: (commands, other) => bot.api.setMyCommands(commands, other),
    },
    start: () => bot.start(),
    stop: () => bot.stop(),
  };
}

/**
 * The channels-owned Telegram lifecycle.
 *
 * This is the approved public startup/restart/shutdown boundary: the extension
 * composition root passes `pi.getCommands()` into `start` and wires the
 * returned lifecycle to root settlement and shutdown.
 */
export function createTelegramLifecycle(options: TelegramLifecycleOptions): TelegramLifecycle {
  const createBotSurface = options.createBot ?? realBot;
  const warn = options.warn ?? ((message) => console.warn(message));
  let listener: ReturnType<typeof createTelegramListener> | undefined;

  return {
    async start(commands: readonly TelegramCommandInfo[]): Promise<void> {
      // Restart semantics: never leave two pollers for the same token.
      if (listener) {
        await listener.stop();
        listener = undefined;
      }
      const channel = loadChannelConfig(options.projectRoot);
      if (channel === null) return;
      try {
        const bot = createBotSurface(channel.botToken);
        listener = createTelegramListener({
          projectRoot: options.projectRoot,
          sessionId: options.sessionId,
          allowedChatIds: channel.allowedChatIds,
          token: channel.botToken,
          bot,
          sendFollowUp: options.sendFollowUp,
          setTelegramMarker: options.setTelegramMarker,
        });
        // Publish the command menu before polling starts; failures warn and
        // never prevent the listener from starting.
        await syncTelegramCommands(bot.api, commands, warn);
        await listener.start();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warn(`Telegram inbound failed to start: ${message}`);
        listener = undefined;
      }
    },
    stopTyping(): void {
      listener?.stopTyping();
    },
    async stop(): Promise<void> {
      const current = listener;
      listener = undefined;
      if (current) await current.stop();
    },
  };
}