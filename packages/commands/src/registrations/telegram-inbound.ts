import type { ExtensionAPI, ExtensionContext, SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { getChildPool } from "@xzy-ai/runtime";
import {
  createBot,
  createTelegramListener,
  loadChannelConfig,
  saveConnectionMarker,
  type TelegramListenerBot,
} from "@xzy-ai/channels";

interface RunningListener {
  stop(): Promise<void>;
}

/** One listener per project root so shutdown can stop exactly the started one. */
const runningByProject = new Map<string, RunningListener>();

function realBot(token: string): TelegramListenerBot {
  const bot = createBot(token);
  return {
    on: (event, middleware) => bot.on(event, middleware),
    api: {
      getFile: (fileId) => bot.api.getFile(fileId),
      sendChatAction: (chatId, action) => bot.api.sendChatAction(chatId, action),
    },
    start: () => bot.start(),
    stop: () => bot.stop(),
  };
}

/**
 * Wire the authorized Telegram inbound path into the extension lifecycle.
 *
 * On `session_start` for the root session (a live session that is not itself a
 * job), this starts a Telegram listener from the project-local channel config
 * and injects every accepted message into the root session as a follow-up. On
 * `session_shutdown` it stops the listener and its typing loop.
 */
export function registerTelegramInbound(pi: ExtensionAPI): void {
  pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
    const channel = loadChannelConfig(ctx.cwd);
    if (channel === null) return;

    // Only the root orchestrator session owns Telegram input; a child session
    // (a job in the scoped registry) never listens.
    const pool = getChildPool(ctx.cwd, ctx.sessionManager.getSessionId());
    if (pool.registry.get(ctx.sessionManager.getSessionId()) !== undefined) return;

    const listener = createTelegramListener({
      projectRoot: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      allowedChatIds: channel.allowedChatIds,
      token: channel.botToken,
      bot: realBot(channel.botToken),
      sendFollowUp(content, options) {
        pi.sendUserMessage(content, options);
        return Promise.resolve();
      },
      setTelegramMarker() {
        saveConnectionMarker(ctx.cwd, {
          lastConnection: "telegram",
          updatedAt: new Date().toISOString(),
        });
      },
    });

    // The listener owns the bot's message middleware; starting it begins polling.
    void listener.start().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.warn(`Telegram inbound failed to start: ${message}`);
    });
    runningByProject.set(ctx.cwd, listener);
  });

  pi.on("session_shutdown", async (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
    const listener = runningByProject.get(ctx.cwd);
    if (!listener) return;
    runningByProject.delete(ctx.cwd);
    await listener.stop().catch(() => {
      // Best-effort; the listener may already be gone.
    });
  });
}