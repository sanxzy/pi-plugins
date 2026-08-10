import type {
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
  formatTelegramCommandSignature,
  formatTelegramSignature,
  parseTelegramCommand,
  readChannelConfig,
  readChannelRuntime,
  writeChannelRuntime,
  type ChannelConfig,
  type TelegramInboundListener,
} from "@xzy-ai/channels";
import { getTelegramProjectManager } from "./telegram-project.ts";

export interface TelegramInboundDeps {
  /** Injectable inbound factory for offline tests. */
  createInbound?: (options: Parameters<typeof createTelegramInbound>[0]) => TelegramInboundListener;
  /**
   * Expand a recognized Telegram slash command into native content. Return the
   * expanded text (command/prompt/skill body) or undefined when the command is
   * unknown and should be injected as literal text instead.
   */
  expandCommand?: (name: string, args: string) => string | undefined;
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

/** Wire the authorized text-only Telegram inbound path into the extension. */
export function registerTelegramInbound(pi: ExtensionAPI, deps: TelegramInboundDeps = {}): void {
  const runningByProject = new Map<string, TelegramInboundListener>();
  const createInbound = deps.createInbound ?? createTelegramInbound;
  const expandCommand = deps.expandCommand ?? (() => undefined);

  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    const projectRoot = canonicalProjectRoot(ctx.cwd);
    const channel = readChannelConfig(projectRoot);
    if (!channel.ok || !isRootSession(ctx)) return;

    const sessionId = ctx.sessionManager.getSessionId();
    const previousRuntime = readChannelRuntime(projectRoot);
    const pairingState = defaultTelegramPairingState(projectRoot);

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
        // Every accepted Telegram message is delivered as a steer, regardless of
        // whether the agent is idle, processing, or waiting on a tool call. PI
        // injects the steer before the next LLM call, so Telegram stays
        // interactive while the active session continues.
        const runtime = writeChannelRuntime(projectRoot, { lastUpdateId: updateId });
        if (!runtime.ok) return;

        // A recognized slash command is dispatched natively: inject only the
        // expanded command content with a compact signature so the message is
        // not split by the long guidance footer. Unknown text keeps the full
        // origin signature.
        const command = parseTelegramCommand(text);
        const expanded = command ? expandCommand(command.name, command.args) : undefined;
        const content = expanded !== undefined
          ? `${expanded}${formatTelegramCommandSignature(chatId)}`
          : `${text}${formatTelegramSignature(chatId)}`;
        pi.sendUserMessage(content, { deliverAs: "steer" });
      },
    });

    if (previousRuntime.ok && previousRuntime.value.lastUpdateId !== undefined) {
      listener.setLastUpdateId(previousRuntime.value.lastUpdateId);
    }

    // Register the message middleware factory before the shared manager starts
    // its poller. Setup and lifecycle reuse this same canonical project manager.
    getTelegramProjectManager({
      projectRoot,
      sessionId,
      createMessageHandler: () => (context) => listener.handle(context),
    });
    runningByProject.set(projectRoot, listener);
    listenersByProject.set(projectRoot, listener);
    listener.setBusy(false);
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
