import type {
  AgentSettledEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { getChildPool } from "@xzy-ai/runtime";
import {
  canonicalProjectRoot,
  createTelegramInbound,
  formatTelegramSignature,
  readChannelConfig,
  readLastConnection,
  writeLastConnection,
  type TelegramInboundListener,
} from "@xzy-ai/channels";
import { getTelegramProjectManager } from "./telegram-project.ts";

export interface TelegramInboundDeps {
  /** Injectable inbound factory for offline tests. */
  createInbound?: (options: Parameters<typeof createTelegramInbound>[0]) => TelegramInboundListener;
}

/** True only for the root orchestrator session. */
function isRootSession(ctx: ExtensionContext): boolean {
  const sessionId = ctx.sessionManager.getSessionId();
  const pool = getChildPool(ctx.cwd, sessionId);
  return pool.rootSessionId === sessionId && pool.registry.get(sessionId) === undefined;
}

/** Wire the authorized text-only Telegram inbound path into the extension. */
export function registerTelegramInbound(pi: ExtensionAPI, deps: TelegramInboundDeps = {}): void {
  const runningByProject = new Map<string, TelegramInboundListener>();
  const createInbound = deps.createInbound ?? createTelegramInbound;

  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    const projectRoot = canonicalProjectRoot(ctx.cwd);
    const channel = readChannelConfig(projectRoot);
    if (!channel.ok || !isRootSession(ctx)) return;

    const sessionId = ctx.sessionManager.getSessionId();
    const previousMarker = readLastConnection(projectRoot);
    const listener = createInbound({
      approvedUserIds: channel.value.approvedUserIds,
      async onAccepted(updateId, chatId, text) {
        const marker = writeLastConnection(projectRoot, {
          lastConnection: "telegram",
          chatRoomId: chatId,
          lastUpdateId: updateId,
          updatedAt: new Date().toISOString(),
        });
        if (!marker.ok) return;
        pi.sendUserMessage(`${text}${formatTelegramSignature(chatId)}`, { deliverAs: "followUp" });
      },
    });

    if (previousMarker.ok && previousMarker.value.lastUpdateId !== undefined) {
      listener.setLastUpdateId(previousMarker.value.lastUpdateId);
    }

    // Register the message middleware factory before the shared manager starts
    // its poller. Setup and lifecycle reuse this same canonical project manager.
    getTelegramProjectManager({
      projectRoot,
      sessionId,
      createMessageHandler: () => (context) => listener.handle(context),
    });
    runningByProject.set(projectRoot, listener);
    listener.setBusy(false);
  });

  pi.on("turn_start", (_event: TurnStartEvent, ctx: ExtensionContext) => {
    runningByProject.get(canonicalProjectRoot(ctx.cwd))?.setBusy(true);
  });

  pi.on("agent_settled", (_event: AgentSettledEvent, ctx: ExtensionContext) => {
    const listener = runningByProject.get(canonicalProjectRoot(ctx.cwd));
    if (!listener) return;
    listener.setBusy(false);
    listener.releaseNext();
  });

  pi.on("session_shutdown", async (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
    const projectRoot = canonicalProjectRoot(ctx.cwd);
    const listener = runningByProject.get(projectRoot);
    if (!listener) return;
    runningByProject.delete(projectRoot);
    listener.stop();
  });
}
