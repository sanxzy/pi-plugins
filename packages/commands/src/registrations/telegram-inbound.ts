import type {
  AgentEndEvent,
  AgentSettledEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { getChildPool } from "@xzy-ai/runtime";
import {
  canonicalProjectRoot,
  createTelegramInbound,
  defaultTelegramPairingState,
  formatTelegramSignature,
  readChannelConfig,
  readLastConnection,
  writeLastConnection,
  type ChannelConfig,
  type TelegramInboundListener,
} from "@xzy-ai/channels";
import { getTelegramProjectManager } from "./telegram-project.ts";

export interface TelegramInboundDeps {
  /** Injectable inbound factory for offline tests. */
  createInbound?: (options: Parameters<typeof createTelegramInbound>[0]) => TelegramInboundListener;
}

const listenersByProject = new Map<string, TelegramInboundListener>();

/** Refresh authorization state after setup approves a pending DM request. */
export function refreshTelegramInbound(projectRoot: string, config: ChannelConfig): void {
  listenersByProject.get(canonicalProjectRoot(projectRoot))?.setApprovedUserIds(config.approvedUserIds);
}

/** True only for the root orchestrator session. */
function isRootSession(ctx: ExtensionContext): boolean {
  const sessionId = ctx.sessionManager.getSessionId();
  const pool = getChildPool(ctx.cwd, sessionId);
  return pool.rootSessionId === sessionId && pool.registry.get(sessionId) === undefined;
}

/** Per-project, per-session Telegram turn bridge state. */
interface TelegramBridgeState {
  /** Accepted Telegram messages queued in arrival order, awaiting a turn. */
  queue: { updateId: number; chatId: string; text: string }[];
  /** True when a Telegram-originated turn is currently being processed. */
  hasActiveTurn: boolean;
  /** Inbound listener that feeds accepted updates into the bridge queue. */
  listener?: TelegramInboundListener;
  /** Deferred dispatch guard; PI must finish the current lifecycle event first. */
  dispatchTimer?: ReturnType<typeof setTimeout>;
}

/** Wire the authorized text-only Telegram inbound path into the extension. */
export function registerTelegramInbound(pi: ExtensionAPI, deps: TelegramInboundDeps = {}): void {
  const runningByProject = new Map<string, TelegramBridgeState>();
  const createInbound = deps.createInbound ?? createTelegramInbound;

  /** Deferred-dispatch delay so PI finishes the current lifecycle event first. */
  const DISPATCH_DELAY_MS = 50;

  const dispatchNow = (ctx: ExtensionContext, bridge: TelegramBridgeState): void => {
    const isIdle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
    if (bridge.hasActiveTurn || bridge.queue.length === 0 || !isIdle) return;
    const item = bridge.queue.shift()!;
    bridge.hasActiveTurn = true;
    const marker = writeLastConnection(canonicalProjectRoot(ctx.cwd), {
      lastConnection: "telegram",
      chatRoomId: item.chatId,
      lastUpdateId: item.updateId,
      updatedAt: new Date().toISOString(),
    });
    if (!marker.ok) {
      bridge.hasActiveTurn = false;
      return;
    }
    // No deliverAs: the agent is idle, so this starts a fresh turn.
    pi.sendUserMessage(`${item.text}${formatTelegramSignature(item.chatId)}`);
  };

  /**
   * Submit one queued Telegram message as a fresh turn, but only when the agent
   * is truly idle. Dispatch is deferred (like the reference queue dispatch
   * runtime) so the current PI lifecycle event fully returns before a new turn
   * starts; the bridge's single active-turn guard serializes delivery.
   */
  const dispatchNext = (ctx: ExtensionContext, bridge: TelegramBridgeState): void => {
    if (bridge.dispatchTimer !== undefined) return;
    bridge.dispatchTimer = setTimeout(() => {
      bridge.dispatchTimer = undefined;
      dispatchNow(ctx, bridge);
    }, DISPATCH_DELAY_MS);
    bridge.dispatchTimer.unref?.();
  };

  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    const projectRoot = canonicalProjectRoot(ctx.cwd);
    const channel = readChannelConfig(projectRoot);
    if (!channel.ok || !isRootSession(ctx)) return;

    const sessionId = ctx.sessionManager.getSessionId();
    const previousMarker = readLastConnection(projectRoot);
    const pairingState = defaultTelegramPairingState(projectRoot);
    const bridge: TelegramBridgeState = { queue: [], hasActiveTurn: false };

    const listener = createInbound({
      approvedUserIds: channel.value.approvedUserIds,
      ...pairingState,
      onChallenge: async (context, chatId, text) => {
        const api = (context as { api?: { sendMessage?: (target: string, content: string) => Promise<unknown> } }).api;
        if (!api?.sendMessage) throw new Error("Telegram challenge sender is unavailable");
        await api.sendMessage(chatId, text);
      },
      onError: () => {
        // Pairing and delivery failures are local-only. The channel logger and
        // lifecycle status remain the operator's diagnostic surfaces.
      },
      async onAccepted(updateId, chatId, text) {
        // Every accepted update flows straight into the bridge queue. The
        // transport must not gate on agent_settled permits: delivery is
        // serialized here by the single active-turn guard.
        bridge.queue.push({ updateId, chatId, text });
        dispatchNext(ctx, bridge);
      },
    });

    bridge.listener = listener;

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
    runningByProject.set(projectRoot, bridge);
    listenersByProject.set(projectRoot, listener);
    listener.setBusy(false);
  });

  pi.on("agent_end", (_event: AgentEndEvent, ctx: ExtensionContext) => {
    if (!isRootSession(ctx)) return;
    const bridge = runningByProject.get(canonicalProjectRoot(ctx.cwd));
    if (!bridge) return;
    // The Telegram-originated turn finished. No text is forwarded here: the
    // assistant communicates through Telegram only by calling the explicit
    // user_telegram_chat tool. The active-turn flag clears when the session
    // settles, then the next queued message may start a turn.
    bridge.hasActiveTurn = false;
  });

  pi.on("agent_settled", (_event: AgentSettledEvent, ctx: ExtensionContext) => {
    if (!isRootSession(ctx)) return;
    const bridge = runningByProject.get(canonicalProjectRoot(ctx.cwd));
    if (!bridge) return;
    // The session is idle again. Drain the next queued Telegram message; the
    // next message may start its turn. The outbound path remains explicit:
    // only user_telegram_chat calls send Telegram text.
    bridge.listener?.releaseNext();
    dispatchNext(ctx, bridge);
  });

  pi.on("session_shutdown", async (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
    if (!isRootSession(ctx)) return;
    const projectRoot = canonicalProjectRoot(ctx.cwd);
    const listener = listenersByProject.get(projectRoot);
    runningByProject.delete(projectRoot);
    listenersByProject.delete(projectRoot);
    listener?.stop();
  });
}
