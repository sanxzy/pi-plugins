import type {
  AgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { getChildPool } from "@xzy-ai/runtime";
import {
  canonicalProjectRoot,
  createTelegramInbound,
  createTelegramOutbound,
  defaultTelegramPairingState,
  extractTelegramMessageOrigin,
  formatTelegramCommandSignature,
  formatTelegramSignature,
  parseTelegramCommand,
  readChannelConfig,
  type TelegramCommand,
  type TelegramMessageOrigin,
  readChannelRuntime,
  writeChannelRuntime,
  type ChannelConfig,
  type TelegramInboundListener,
} from "@xzy-ai/channels";
import { getTelegramProjectManager } from "./telegram-project.ts";
import { dispatchTelegramControl, type TelegramControlDispatchOptions } from "./telegram-controls.ts";

export interface TelegramInboundDeps {
  /** Injectable inbound factory for offline tests. */
  createInbound?: (options: Parameters<typeof createTelegramInbound>[0]) => TelegramInboundListener;
  /**
   * Expand a recognized Telegram slash command into native content. Return the
   * expanded text (command/prompt/skill body) or undefined when the command is
   * unknown and should be injected as literal text instead.
   */
  expandCommand?: (name: string, args: string) => string | undefined;
  /** Dispatch a Telegram-native control directly (e.g. /compact). */
  dispatchControl?: (command: TelegramCommand, options: TelegramControlDispatchOptions) => Promise<boolean>;
  /** Injectable Telegram reaction boundary for agent-start acknowledgement. */
  reactTelegramMessage?: (projectRoot: string, origin: TelegramMessageOrigin) => Promise<void>;
}

const listenersByProject = new Map<string, TelegramInboundListener>();

function latestUserMessageText(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "message" || entry.message.role !== "user") continue;
    return typeof entry.message.content === "string"
      ? entry.message.content
      : entry.message.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n");
  }
  return undefined;
}

/** Refresh authorization state after setup approves a pending DM request. */
export function refreshTelegramInbound(projectRoot: string, config: ChannelConfig): void {
  listenersByProject.get(canonicalProjectRoot(projectRoot))?.setApprovedUserIds(config.approvedUserIds);
}

/** True only for a host session, never for a registered child job. */
function isRootSession(ctx: ExtensionContext): boolean {
  const pool = getChildPool(ctx.cwd, ctx.sessionManager.getSessionId());
  // The shared pool keeps its first rootSessionId across host replacement
  // (/new, reload, resume). The registry is the stable discriminator: child
  // sessions are jobs, while every replacement root is not.
  return pool.registry.get(ctx.sessionManager.getSessionId()) === undefined;
}

/** Wire the authorized text-only Telegram inbound path into the extension. */
export function registerTelegramInbound(pi: ExtensionAPI, deps: TelegramInboundDeps = {}): void {
  const runningByProject = new Map<string, TelegramInboundListener>();
  const createInbound = deps.createInbound ?? createTelegramInbound;
  const expandCommand = deps.expandCommand ?? (() => undefined);
  const dispatchControl = deps.dispatchControl ?? ((command, options) => dispatchTelegramControl(command, options));
  const reactTelegramMessage = deps.reactTelegramMessage ?? ((projectRoot, origin) => {
    if (origin.messageId === undefined) return Promise.resolve();
    return createTelegramOutbound().react(projectRoot, origin.chatId, origin.messageId, [{ type: "emoji", emoji: "👍" }]).then(() => undefined);
  });
  let activeListener: TelegramInboundListener | undefined;

  // Acknowledge the latest Telegram-originated user message when the agent loop
  // begins. Non-blocking: a failed reply reaction must not delay or break the run.
  pi.on("agent_start", (_event: AgentStartEvent, ctx: ExtensionContext) => {
    const projectRoot = canonicalProjectRoot(ctx.cwd);
    const latestUserMessage = latestUserMessageText(ctx);
    if (!latestUserMessage) return;
    const origin = extractTelegramMessageOrigin(latestUserMessage);
    if (!origin) return;
    void reactTelegramMessage(projectRoot, origin).catch(() => undefined);
  });

  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    const projectRoot = canonicalProjectRoot(ctx.cwd);
    if (!isRootSession(ctx)) return;

    // The inbound listener (and therefore the manager's message-handler
    // factory) must be registered even when no channel config exists yet.
    // Otherwise first-time setup starts a poller with `onMessage: undefined`
    // and live DMs never reach this listener, so no pairing request is ever
    // created. The listener's own readConfig() picks up the config as soon as
    // setup writes it.
    const channel = readChannelConfig(projectRoot);
    const approvedUserIds = channel.ok ? channel.value.approvedUserIds : [];

    const sessionId = ctx.sessionManager.getSessionId();
    const previousRuntime = readChannelRuntime(projectRoot);
    const pairingState = defaultTelegramPairingState(projectRoot);

    const listener = createInbound({
      approvedUserIds,
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
      async onAccepted(updateId, chatId, text, messageId) {
        // Every accepted Telegram message is delivered as a steer, regardless of
        // whether the agent is idle, processing, or waiting on a tool call. PI
        // injects the steer before the next LLM call, so Telegram stays
        // interactive while the active session continues.
        const runtime = writeChannelRuntime(projectRoot, { lastUpdateId: updateId });
        if (!runtime.ok) return;

        const command = parseTelegramCommand(text);
        // Telegram-native controls are handled directly (e.g. /compact) and
        // never enter the model prompt stream.
        if (command) {
          const handled = await dispatchControl(command, {
            projectRoot,
            chatId,
            context: ctx,
            pi: {
              setModel: (model) => pi.setModel(model),
              getThinkingLevel: () => pi.getThinkingLevel(),
              setThinkingLevel: (level) => pi.setThinkingLevel(level),
            },
            clearQueue: () => activeListener?.clearQueue(),
          });
          if (handled) return;
        }
        // A recognized slash command is dispatched natively: inject only the
        // expanded command content with a compact signature so the message is
        // not split by the long guidance footer. Unknown text keeps the full
        // origin signature.
        const expanded = command ? expandCommand(command.name, command.args) : undefined;
        const content = expanded !== undefined
          ? `${expanded}${formatTelegramCommandSignature(chatId, messageId)}`
          : `${text}${formatTelegramSignature(chatId, messageId)}`;
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
    activeListener = listener;
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
    activeListener = undefined;
    listener?.stop();
  });
}
