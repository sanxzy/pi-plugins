import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  reactToMessage,
  sendTelegramMessage,
  validateStandardReaction,
  validateTelegramTarget,
  type OutboundTextResult,
  type TelegramTargetValidation,
} from "@xzy-ai/channels";
import { telegramChatParams, type TelegramChatParams } from "../tools.ts";
import { errorResult, textResult } from "../results.ts";
import type { TelegramChatDetails } from "../types.ts";

export type { TelegramChatDetails } from "../types.ts";

export interface TelegramChatDeps {
  /** Injectable send seam so tests verify delivery and partial results offline. */
  send?: (projectRoot: string, chatId: string, message: string, options?: {
    format?: "plain" | "html" | "markdown_v2";
    messageId?: number;
    linkPreviewOptions?: Record<string, unknown>;
    disableNotification?: boolean;
  }) => Promise<OutboundTextResult>;
  /**
   * Injectable explicit-target gate. The default reuses the approved-user
   * allowlist from the channel configuration and rejects any unapproved or
   * unsupported destination before any outbound API call.
   */
  validateTarget?: (projectRoot: string, chatId: string) => Promise<TelegramTargetValidation>;
  /** Injectable reaction seam so tests verify delivery offline. */
  react?: (projectRoot: string, chatId: string, messageId: number, emoji: string) => Promise<OutboundTextResult>;
}

/** Register the parent-only unified Telegram communication/reporting tool. */
export function registerTelegramChatTool(pi: ExtensionAPI, deps: TelegramChatDeps = {}): void {
  const send = deps.send ?? sendTelegramMessage;
  const react = deps.react ?? reactToMessage;
  const validateTarget = deps.validateTarget ?? (async (projectRoot: string, chatId: string) =>
    validateTelegramTarget(projectRoot, chatId));

  pi.registerTool({
    name: "user_telegram_chat",
    label: "Telegram",
    description: "Send a communication or report to an approved Telegram private chat. Requires an explicit action and chat_id; refuses unapproved or unsupported targets.",
    parameters: telegramChatParams,
    async execute(
      _toolCallId: string,
      params: TelegramChatParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<TelegramChatDetails>> {
      const target = await validateTarget(ctx.cwd, params.chat_id);
      if (!target.ok) {
        return errorResult(target.error, {
          action: params.action,
          sent: false,
          chatId: params.chat_id,
          error: target.error,
          category: target.category,
        });
      }

      if (params.action === "react") {
        if (!validateStandardReaction(params.emoji)) {
          return errorResult("Unsupported reaction", {
            action: params.action,
            sent: false,
            chatId: target.chatId,
            messageId: params.message_id,
            emoji: params.emoji,
            error: "Unsupported reaction",
            category: "telegram_rejected",
          });
        }
        const reactionResult = await react(ctx.cwd, target.chatId, params.message_id, params.emoji);
        if (!reactionResult.ok) {
          return errorResult(`Telegram reaction failed: ${reactionResult.error}`, {
            action: params.action,
            sent: false,
            chatId: target.chatId,
            messageId: params.message_id,
            emoji: params.emoji,
            error: reactionResult.error,
            category: reactionResult.category,
          });
        }
        return textResult(`Reaction applied to message ${params.message_id}`, {
          action: params.action,
          sent: true,
          chatId: target.chatId,
          messageId: params.message_id,
          emoji: params.emoji,
        });
      }

      const result = await send(ctx.cwd, target.chatId, params.text, {
        format: params.format,
        messageId: params.message_id,
        linkPreviewOptions: params.link_preview_options,
        disableNotification: params.disable_notification,
      });
      if (!result.ok) {
        return errorResult(`Telegram delivery failed: ${result.error}`, {
          action: params.action,
          sent: false,
          chatId: target.chatId,
          sentChunks: result.sent,
          failedChunks: result.failed,
          error: result.error,
          category: result.category,
        });
      }
      return textResult(`Telegram message sent (${result.sent} message${result.sent === 1 ? "" : "s"})`, {
        action: params.action,
        sent: true,
        chatId: target.chatId,
        chunks: result.sent,
        messageIds: result.messageIds,
      });
    },
    renderCall(args: TelegramChatParams, theme) {
      const summary = args.action === "send_text"
        ? args.text
        : `react ${args.emoji} → ${args.chat_id}:${args.message_id}`;
      return new Text(theme.fg("toolTitle", theme.bold("user_telegram_chat ")) + theme.fg("muted", summary), 0, 0);
    },
    renderResult(result: AgentToolResult<TelegramChatDetails>, _options, theme) {
      const details = result.details;
      if (!details?.sent) return new Text(theme.fg("warning", "Telegram delivery unavailable"), 0, 0);
      const suffix = details.chunks && details.chunks > 1 ? ` (${details.chunks} chunks)` : "";
      return new Text(theme.fg("success", `✓ Sent to Telegram${suffix}`), 0, 0);
    },
  });
}