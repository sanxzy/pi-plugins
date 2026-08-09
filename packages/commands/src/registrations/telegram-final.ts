import type {
  AgentSettledEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import {
  canSendTelegram,
  clearTelegramToolSends,
  sendTelegramMessage,
  wasTelegramToolSend,
  type OutboundTextResult,
} from "@xzy-ai/channels";
import { getChildPool } from "@xzy-ai/runtime";

export interface TelegramFinalForwardingDeps {
  send?: (projectRoot: string, text: string) => Promise<OutboundTextResult>;
  wasSentByTool?: (projectRoot: string, text: string) => boolean;
  warn?: (message: string) => void;
}

function isRootSession(ctx: ExtensionContext): boolean {
  const sessionId = ctx.sessionManager.getSessionId();
  const pool = getChildPool(ctx.cwd, sessionId);
  return pool.rootSessionId === sessionId && pool.registry.get(sessionId) === undefined;
}

type EventLike = {
  message: { role: string; content?: unknown };
};

function assistantText(event: EventLike): string | undefined {
  const message = event.message;
  if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter((part: { type?: string; text?: string }): part is { type: string; text: string } => part?.type === "text")
    .map((part) => part.text)
    .join("");
  return text.length > 0 ? text : undefined;
}

/** Wire root-only automatic final Telegram forwarding. */
export function registerTelegramFinalForwarding(
  pi: ExtensionAPI,
  deps: TelegramFinalForwardingDeps = {},
): void {
  const send = deps.send ?? sendTelegramMessage;
  const wasSent = deps.wasSentByTool ?? wasTelegramToolSend;
  const warn = deps.warn ?? ((message) => console.warn(message));
  const latestByProject = new Map<string, string>();

  pi.on("message_end", (event, ctx) => {
    if (!isRootSession(ctx)) return;
    const text = assistantText(event);
    if (text !== undefined) latestByProject.set(ctx.cwd, text);
  });

  pi.on("agent_settled", async (_event: AgentSettledEvent, ctx: ExtensionContext) => {
    if (!isRootSession(ctx)) return;
    const text = latestByProject.get(ctx.cwd);
    latestByProject.delete(ctx.cwd);
    if (text === undefined || !canSendTelegram(ctx.cwd) || wasSent(ctx.cwd, text)) {
      clearTelegramToolSends(ctx.cwd);
      return;
    }
    try {
      const result = await send(ctx.cwd, text);
      if (!result.ok) warn(`Telegram automatic final delivery failed: ${result.error}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(`Telegram automatic final delivery failed: ${message}`);
    } finally {
      clearTelegramToolSends(ctx.cwd);
    }
  });

  pi.on("session_shutdown", async (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
    if (!isRootSession(ctx)) return;
    latestByProject.delete(ctx.cwd);
    clearTelegramToolSends(ctx.cwd);
  });
}
