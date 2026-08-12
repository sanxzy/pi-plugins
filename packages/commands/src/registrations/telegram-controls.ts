import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  canonicalProjectRoot,
  sendTelegramMessage,
  type TelegramCommand,
} from "@xzy-ai/channels";
import { TELEGRAM_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { clearSessionReload, markSessionReload } from "./session-events.ts";

export interface TelegramControlDispatchOptions {
  projectRoot: string;
  chatId: string;
  /** Telegram message id of the native command, used for post-compact acknowledgement. */
  messageId?: number;
  context: ExtensionContext;
  /** Public Pi API used by model/thinking controls. */
  pi?: Pick<ExtensionAPI, "setModel" | "getThinkingLevel" | "setThinkingLevel">;
  /** Clear waiting Telegram messages without stopping the listener. */
  clearQueue?: () => void;
  /** Injectable reply boundary for tests. */
  sendMessage?: (projectRoot: string, chatId: string, text: string) => Promise<unknown>;
  /** Development-mode gate used by /system_prompt. Defaults to a real env read. */
  isDevMode?: () => boolean;
}

/**
 * Bridge for Telegram controls that need command-only Pi APIs.
 *
 * Pi exposes `reload()` on ExtensionCommandContext, while lifecycle handlers
 * receive only ExtensionContext. The lifecycle registration retains a fresh
 * command context per project root in this process-local registry at
 * session_start; dispatch reads it, falling back to a freshly created context
 * through the `createCommandContext` seam when the retained one is absent.
 */
const TELEGRAM_COMMAND_CONTEXTS_KEY = Symbol.for("@xzy-ai/pi-code:telegram-command-contexts");

type TelegramCommandContextRegistry = Map<string, ExtensionCommandContext>;

function telegramCommandContextRegistry(): TelegramCommandContextRegistry {
  const global = globalThis as unknown as Record<symbol, TelegramCommandContextRegistry | undefined>;
  global[TELEGRAM_COMMAND_CONTEXTS_KEY] ??= new Map<string, ExtensionCommandContext>();
  return global[TELEGRAM_COMMAND_CONTEXTS_KEY] as TelegramCommandContextRegistry;
}

/** Retain the command context for a project so native controls can use it. */
export function setTelegramCommandContext(projectRoot: string, context: ExtensionCommandContext | undefined): void {
  const registry = telegramCommandContextRegistry();
  const key = canonicalProjectRoot(projectRoot);
  if (context === undefined) registry.delete(key);
  else registry.set(key, context);
}

/** Read the retained command context for a project, if populated. */
export function getTelegramCommandContext(projectRoot: string): ExtensionCommandContext | undefined {
  return telegramCommandContextRegistry().get(canonicalProjectRoot(projectRoot));
}

/** Drop the retained command context for a project (e.g. on session shutdown). */
export function clearTelegramCommandContext(projectRoot: string): void {
  telegramCommandContextRegistry().delete(canonicalProjectRoot(projectRoot));
}

const compactionByProject = new Set<string>();
/** Pending Telegram origin of an in-flight native /compact, keyed by project root and originating root session. */
const pendingCompactionOriginByProject = new Map<string, { chatId: string; messageId: number }>();
const PENDING_KEY_SEPARATOR = "\u0000";
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;

function compactionOriginKey(projectRoot: string, sessionId: string): string {
  return `${projectRoot}${PENDING_KEY_SEPARATOR}${sessionId}`;
}

/** Take the pending post-compaction Telegram origin for a project/root session, if any. */
export function takeTelegramCompactionOrigin(projectRoot: string, sessionId: string): { chatId: string; messageId: number } | undefined {
  const key = compactionOriginKey(projectRoot, sessionId);
  const origin = pendingCompactionOriginByProject.get(key);
  pendingCompactionOriginByProject.delete(key);
  return origin;
}

/** Discard any pending Telegram origin for a project/root session (e.g. on shutdown/replacement). */
export function clearTelegramCompactionOrigin(projectRoot: string, sessionId: string): void {
  pendingCompactionOriginByProject.delete(compactionOriginKey(projectRoot, sessionId));
}

/** True only when the operator explicitly enables development mode. */
export function isTelegramDevelopmentMode(): boolean {
  const value = process.env.PI_CODE_DEV;
  return value === "1" || value === "true";
}
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

function formatContextUsage(context: ExtensionContext): string {
  const usage = context.getContextUsage();
  if (!usage) return "Context usage: unavailable.";
  const tokens = usage.tokens === null ? "unknown" : usage.tokens.toLocaleString("en-US");
  const percent = usage.percent === null ? "unknown" : `${usage.percent.toFixed(1)}%`;
  return `Context usage: ${tokens} / ${usage.contextWindow.toLocaleString("en-US")} tokens (${percent}).`;
}

function formatModel(context: ExtensionContext): string {
  const model = context.model;
  return model ? `${model.provider}/${model.id}` : "none";
}

function modelMatches(model: { provider: string; id: string; name: string }, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return [
    `${model.provider}/${model.id}`,
    model.id,
    model.name,
  ].some((value) => value.toLowerCase() === normalized);
}

/**
 * Dispatch Telegram-native controls without injecting them as model prompts.
 * Returns true when the command is owned by this control handler.
 */
export async function dispatchTelegramControl(
  command: TelegramCommand,
  options: TelegramControlDispatchOptions,
): Promise<boolean> {
  return processWithLog({ operation: TELEGRAM_OPERATIONS.CONTROLS_DISPATCH, parameters: { command: command.name } }, async () => {
  const owned = new Set([
    "compact",
    "abort",
    "stop",
    "reload",
    "context",
    "status",
    "system_prompt",
    "model",
    "thinking",
  ]);
  if (!owned.has(command.name)) return false;

  const send = options.sendMessage ?? (async (projectRoot, chatId, text) => {
    await sendTelegramMessage(projectRoot, chatId, text);
  });
  const reply = async (text: string): Promise<void> => {
    try {
      await send(options.projectRoot, options.chatId, text);
    } catch {
      // The control has already been handled. A reply failure must not turn it
      // into a model prompt or surface as an unhandled inbound rejection.
    }
  };

  switch (command.name) {
    case "compact": {
      if (
        !options.context.isIdle() ||
        options.context.hasPendingMessages() ||
        compactionByProject.has(options.projectRoot)
      ) {
        await reply("Cannot compact while Pi is busy or has pending messages. Wait for the current work to finish or send /abort first.");
        return true;
      }

      compactionByProject.add(options.projectRoot);
      if (options.messageId !== undefined) {
        const sessionId = options.context.sessionManager.getSessionId();
        pendingCompactionOriginByProject.set(compactionOriginKey(options.projectRoot, sessionId), { chatId: options.chatId, messageId: options.messageId });
      }
      await reply("🗜 Compaction started.");
      const finish = async (message: string, success: boolean): Promise<void> => {
        compactionByProject.delete(options.projectRoot);
        if (!success) {
          const sessionId = options.context.sessionManager.getSessionId();
          pendingCompactionOriginByProject.delete(compactionOriginKey(options.projectRoot, sessionId));
        }
        await reply(message);
      };
      try {
        options.context.compact({
          onComplete: () => {
            void finish("✅ Compaction completed.", true);
          },
          onError: (error) => {
            const message = error instanceof Error ? error.message : String(error);
            void finish(`Compaction failed: ${message}`, false);
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await finish(`Compaction failed: ${message}`, false);
      }
      return true;
    }

    case "abort": {
      const wasBusy = !options.context.isIdle();
      options.context.abort();
      await reply(wasBusy ? "⏹ Current Pi operation aborted." : "No active Pi operation.");
      return true;
    }

    case "stop": {
      const wasBusy = !options.context.isIdle();
      options.context.abort();
      options.clearQueue?.();
      await reply(wasBusy ? "🛑 Pi operation aborted and Telegram queue cleared." : "🛑 Telegram queue cleared; no active Pi operation.");
      return true;
    }

    case "reload": {
      if (!options.context.isIdle() || options.context.hasPendingMessages()) {
        await reply("Cannot reload while Pi is busy or has pending messages. Send /abort first.");
        return true;
      }
      const commandContext = getTelegramCommandContext(options.projectRoot);
      if (!commandContext) {
        await reply("Pi session reload is unavailable in the current Pi runtime. Restart the active Pi session and try again.");
        return true;
      }
      await reply("♻️ Reloading the active Pi session...");
      // Set the marker before reload tears down this extension runtime. The
      // fresh session_start handler consumes it and sends the steer through
      // the new, valid ExtensionAPI instance.
      markSessionReload(options.projectRoot);
      try {
        await commandContext.reload();
        await reply("✅ Active Pi session reloaded.");
      } catch (error) {
        clearSessionReload(options.projectRoot);
        const message = error instanceof Error ? error.message : String(error);
        await reply(`Pi session reload failed: ${message}`);
      }
      return true;
    }

    case "context":
      await reply(formatContextUsage(options.context));
      return true;

    case "status":
      await reply([
        `Status: ${options.context.isIdle() ? "idle" : "busy"}.`,
        `Pending messages: ${options.context.hasPendingMessages() ? "yes" : "no"}.`,
        `Model: ${formatModel(options.context)}.`,
        `Thinking: ${options.pi?.getThinkingLevel() ?? "unavailable"}.`,
        formatContextUsage(options.context),
      ].join("\n"));
      return true;

    case "system_prompt": {
      const isDevMode = options.isDevMode ?? isTelegramDevelopmentMode;
      if (!isDevMode()) {
        await reply("[/system_prompt] Development mode is disabled. Set PI_CODE_DEV=1 to enable this command.");
        return true;
      }
      await reply(`[Development] Effective system prompt:\n\n${options.context.getSystemPrompt()}`);
      return true;
    }

    case "thinking": {
      if (!options.pi) {
        await reply("Thinking control is unavailable.");
        return true;
      }
      const requested = command.args.trim().toLowerCase();
      if (!requested) {
        await reply(`Thinking: ${options.pi.getThinkingLevel()}.\nChoose: ${THINKING_LEVELS.join(", ")}.`);
        return true;
      }
      if (!(THINKING_LEVELS as readonly string[]).includes(requested)) {
        await reply(`Invalid thinking level. Choose: ${THINKING_LEVELS.join(", ")}.`);
        return true;
      }
      options.pi.setThinkingLevel(requested as ThinkingLevel);
      await reply(`🧠 Thinking level set to ${options.pi.getThinkingLevel()}.`);
      return true;
    }

    case "model": {
      if (!options.pi) {
        await reply("Model control is unavailable.");
        return true;
      }
      const available = options.context.modelRegistry.getAvailable();
      const query = command.args.trim();
      if (!query) {
        if (available.length === 0) {
          await reply("No authenticated models are available.");
          return true;
        }
        const lines = available.map((model) => {
          const current = options.context.model?.provider === model.provider && options.context.model?.id === model.id;
          return `${current ? "•" : "-"} ${model.provider}/${model.id}${model.name ? ` — ${model.name}` : ""}`;
        });
        await reply(`Available models:\n${lines.join("\n")}\n\nUse /model <provider>/<id> to switch.`);
        return true;
      }
      const selected = available.find((model) => modelMatches(model, query));
      if (!selected) {
        await reply(`Model not found or unavailable: ${query}. Use /model to list authenticated models.`);
        return true;
      }
      if (!options.context.isIdle() || options.context.hasPendingMessages()) {
        await reply("Cannot switch model while Pi is busy or has pending messages. Send /abort first.");
        return true;
      }
      const changed = await options.pi.setModel(selected);
      await reply(changed
        ? `🤖 Model set to ${selected.provider}/${selected.id}.`
        : `Unable to activate ${selected.provider}/${selected.id}: authentication is unavailable.`);
      return true;
    }

    default:
      return false;
  }
  });
}

/** Test isolation seam for the process-local compaction guard. */
export function clearTelegramControlState(): void {
  compactionByProject.clear();
  pendingCompactionOriginByProject.clear();
}
