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
  sendTelegramMessage,
  writeLastConnection,
  type ChannelConfig,
  type TelegramInboundListener,
} from "@xzy-ai/channels";
import { getTelegramProjectManager } from "./telegram-project.ts";

export interface TelegramInboundDeps {
  /** Injectable inbound factory for offline tests. */
  createInbound?: (options: Parameters<typeof createTelegramInbound>[0]) => TelegramInboundListener;
  /** Injectable marker-gated outbound sender for offline tests. */
  sendOutbound?: (projectRoot: string, text: string) => Promise<unknown>;
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

function getAgentMessageText(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  const blocks = Array.isArray(content) ? content : [];
  return blocks
    .filter(
      (block): block is { type: string; text?: string } =>
        typeof block === "object" && block !== null && "type" in block,
    )
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("")
    .trim();
}

/**
 * Text and stop reason of the latest assistant message in an agent-end payload.
 * Mirrors the reference assistant extraction: scan backward to the newest
 * assistant message and read its text blocks.
 */
function extractLatestAssistant(
  messages: readonly unknown[],
): { text?: string; stopReason?: string } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || (message as { role?: string }).role !== "assistant") continue;
    const text = getAgentMessageText(message);
    const rawStopReason = (message as { stopReason?: unknown }).stopReason;
    return {
      text: text || undefined,
      stopReason: typeof rawStopReason === "string" ? rawStopReason : undefined,
    };
  }
  return undefined;
}

/** Wire the authorized text-only Telegram inbound path into the extension. */
export function registerTelegramInbound(pi: ExtensionAPI, deps: TelegramInboundDeps = {}): void {
  const runningByProject = new Map<string, TelegramBridgeState>();
  const createInbound = deps.createInbound ?? createTelegramInbound;
  const sendOutbound = deps.sendOutbound ?? sendTelegramMessage;

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

  pi.on("agent_end", (event: AgentEndEvent, ctx: ExtensionContext) => {
    if (!isRootSession(ctx)) return;
    const projectRoot = canonicalProjectRoot(ctx.cwd);
    const bridge = runningByProject.get(projectRoot);
    if (!bridge || !bridge.hasActiveTurn) return;
    // Forward the root parent's final assistant text back to Telegram. This is
    // the only automatic outbound delivery and it is limited to Telegram-originated
    // turns; TUI turns, child sessions, tool calls, and status updates never
    // reach Telegram here. Aborted or failed runs send nothing.
    const assistant = extractLatestAssistant(event.messages);
    if (assistant?.text && assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
      try {
        void sendOutbound(projectRoot, assistant.text).catch(() => {
          // Outbound failures are local-only; the operator's channel logger is
          // the diagnostic surface.
        });
      } catch (error) {
        // The injectable sender may fail synchronously; keep that local too.
        void error;
      }
    }
    bridge.hasActiveTurn = false;
    // The agent loop is still unwinding here; the actual next dispatch happens
    // once agent_settled confirms the session is idle again.
  });

  pi.on("agent_settled", (_event: AgentSettledEvent, ctx: ExtensionContext) => {
    if (!isRootSession(ctx)) return;
    const bridge = runningByProject.get(canonicalProjectRoot(ctx.cwd));
    if (!bridge) return;
    // Release the transport queue's settlement permit so the next accepted
    // Telegram update flows through onAccepted, then drain the bridge queue.
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
