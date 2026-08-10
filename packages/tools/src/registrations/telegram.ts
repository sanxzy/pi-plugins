import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  extractTelegramChatId,
  sendTelegramMessage,
  type OutboundTextResult,
} from "@xzy-ai/channels";
import { telegramChatParams, type TelegramChatParams } from "../tools.ts";
import { errorResult, textResult } from "../results.ts";
import type { TelegramChatDetails } from "../types.ts";

export type { TelegramChatDetails } from "../types.ts";

export interface TelegramChatDeps {
  /** Injectable send seam so tests verify delivery and partial results offline. */
  send?: (projectRoot: string, chatId: string, message: string) => Promise<OutboundTextResult>;
  /**
   * Injectable reply-target resolver so tests do not need real session state.
   * The default resolves the chat id from the Telegram origin signature of the
   * latest user message in the current session branch.
   */
  resolveChat?: (ctx: ExtensionContext) => string | undefined;
}

/**
 * Default reply-target resolver. Every accepted Telegram follow-up carries the
 * exact origin signature `[from:telegram:<chatId>]`; the latest user message in
 * the session is therefore the authoritative connection marker — no persisted
 * state is needed. Returns undefined when the latest user message is not
 * Telegram-originated (e.g. a TUI prompt).
 */
export function resolveTelegramChatFromSession(ctx: ExtensionContext): string | undefined {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "user") continue;
    const content = message.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : "")).join("")
        : "";
    return extractTelegramChatId(text);
  }
  return undefined;
}

/** Register the parent-only text communication/reporting tool. */
export function registerTelegramChatTool(pi: ExtensionAPI, deps: TelegramChatDeps = {}): void {
  const send = deps.send ?? sendTelegramMessage;
  const resolveChat = deps.resolveChat ?? resolveTelegramChatFromSession;
  pi.registerTool({
    name: "user_telegram_chat",
    label: "Telegram",
    description: "Send a communication or report to the Telegram chat that sent the latest user message. Refuses when the latest user message did not come from Telegram.",
    parameters: telegramChatParams,
    async execute(
      _toolCallId: string,
      params: TelegramChatParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<TelegramChatDetails>> {
      const chatId = resolveChat(ctx);
      if (chatId === undefined) {
        return errorResult("Telegram delivery is unavailable because the latest user message is not from Telegram", {
          sent: false,
          message: params.message,
          error: "connection_not_telegram",
        });
      }

      const result = await send(ctx.cwd, chatId, params.message);
      if (!result.ok) {
        return errorResult(`Telegram delivery failed: ${result.error}`, {
          sent: false,
          message: params.message,
          sentChunks: result.sent,
          failedChunks: result.failed,
          error: result.error,
        });
      }
      return textResult(`Telegram message sent (${result.sent} message${result.sent === 1 ? "" : "s"})`, {
        sent: true,
        message: params.message,
        chunks: result.sent,
      });
    },
    renderCall(args: TelegramChatParams, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("user_telegram_chat ")) + theme.fg("muted", args.message), 0, 0);
    },
    renderResult(result: AgentToolResult<TelegramChatDetails>, _options, theme) {
      const details = result.details;
      if (!details?.sent) return new Text(theme.fg("warning", "Telegram delivery unavailable"), 0, 0);
      const suffix = details.chunks && details.chunks > 1 ? ` (${details.chunks} chunks)` : "";
      return new Text(theme.fg("success", `✓ Sent to Telegram${suffix}`), 0, 0);
    },
  });
}
