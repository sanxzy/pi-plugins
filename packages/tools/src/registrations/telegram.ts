import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  clearTelegramChoiceTokens,
  createTelegramChoice,
  createTelegramOutbound,
  resolveMediaSource,
  reactToMessage,
  sendTelegramMessage,
  validateStandardReaction,
  validateTelegramTarget,
  type OutboundChoiceResult,
  type OutboundMediaResult,
  type OutboundTextResult,
  type TelegramChoice,
  type TelegramMediaInput,
  type TelegramMediaType,
  type TelegramTargetValidation,
} from "@xzy-ai/channels";
import { telegramChatParams, type TelegramChatParams } from "../tools.ts";
import { errorResult, textResult } from "../results.ts";
import type { TelegramChatDetails } from "../types.ts";

export type { TelegramChatDetails } from "../types.ts";

const TELEGRAM_TOKEN_PATTERN = /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g;
const SENSITIVE_QUERY_PATTERN = /([?&](?:token|secret|api[_-]?key|password|credential)=)[^&#\s]+/gi;

function safeTelegramError(error: unknown): string {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "Telegram delivery failed";
  return message
    .replace(TELEGRAM_TOKEN_PATTERN, "[Redacted]")
    .replace(SENSITIVE_QUERY_PATTERN, "$1[Redacted]");
}

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
  /** Injectable choice prompt seam so tests verify delivery offline. */
  sendChoices?: (projectRoot: string, chatId: string, question: string, choices: TelegramChoice[], replyToMessageId?: number, sessionId?: string) => Promise<OutboundChoiceResult>;
  /** Injectable media source resolution and delivery seam. */
  sendMedia?: (projectRoot: string, chatId: string, mediaType: TelegramMediaType, source: TelegramMediaInput, options?: { caption?: string; filename?: string }) => Promise<OutboundMediaResult>;
}

/** Register the parent-only unified Telegram communication/reporting tool. */
export function registerTelegramChatTool(pi: ExtensionAPI, deps: TelegramChatDeps = {}): void {
  const send = deps.send ?? sendTelegramMessage;
  const react = deps.react ?? reactToMessage;
  const sendChoices = deps.sendChoices ?? (async (projectRoot: string, chatId: string, question: string, choices: TelegramChoice[], replyToMessageId?: number, sessionId = "root") => {
    const choiceState = createTelegramChoice({
      projectRoot,
      sessionId,
      chatId,
      senderId: chatId,
      question,
      choices,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    const result = await createTelegramOutbound().sendChoices(
      projectRoot,
      chatId,
      question,
      choices.map((choice, index) => ({ label: choice.label, callbackData: choiceState.callbackData[index]! })),
      replyToMessageId,
    );
    if (!result.ok) clearTelegramChoiceTokens(choiceState.callbackData);
    return result;
  });
  const validateTarget = deps.validateTarget ?? (async (projectRoot: string, chatId: string) =>
    validateTelegramTarget(projectRoot, chatId));
  const sendMedia = deps.sendMedia ?? (async (projectRoot: string, chatId: string, mediaType: TelegramMediaType, source: TelegramMediaInput, options: { caption?: string; filename?: string } = {}, sessionId = "root") => {
    const resolved = await resolveMediaSource(source, mediaType, options.filename, { projectRoot, sessionId });
    if (!resolved.ok) return resolved;
    return createTelegramOutbound().sendMedia(projectRoot, chatId, mediaType, resolved.source, options);
  });

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
      const action = (params as { action?: unknown }).action;
      if (action !== "send_text" && action !== "react" && action !== "send_choices" && action !== "send_media") {
        return errorResult("Unsupported Telegram action", {
          action: "send_text",
          sent: false,
          chatId: typeof (params as { chat_id?: unknown }).chat_id === "string" ? (params as { chat_id: string }).chat_id : "",
          error: "Unsupported Telegram action",
          category: "telegram_rejected",
        });
      }
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

      if (params.action === "send_choices") {
        const labels = new Set<string>();
        const values = new Set<string>();
        for (const choice of params.choices) {
          if (labels.has(choice.label) || values.has(choice.value)) {
            return errorResult("Choice labels and values must be unique", {
              action: params.action,
              sent: false,
              chatId: target.chatId,
              question: params.question,
              error: "Choice labels and values must be unique",
              category: "telegram_rejected",
            });
          }
          labels.add(choice.label);
          values.add(choice.value);
        }
        const choiceResult = await sendChoices(ctx.cwd, target.chatId, params.question, params.choices, params.message_id, ctx.sessionManager.getSessionId());
        if (!choiceResult.ok) {
          const error = safeTelegramError(choiceResult.error);
          return errorResult(`Telegram choices failed: ${error}`, {
            action: params.action,
            sent: false,
            chatId: target.chatId,
            question: params.question,
            error,
            category: choiceResult.category,
          });
        }
        return textResult(`Telegram choices sent (${params.choices.length} options)`, {
          action: params.action,
          sent: true,
          chatId: target.chatId,
          question: params.question,
          messageId: choiceResult.messageId,
          expiresAt: choiceResult.expiresAt,
        });
      }

      if (params.action === "send_media") {
        if (params.source.kind !== "file_id" && params.source.kind !== "artifact_id" && params.source.kind !== "https") {
          return errorResult("Unsupported media source", {
            action: params.action,
            sent: false,
            chatId: target.chatId,
            mediaType: params.media_type,
            error: "Unsupported media source",
            category: "telegram_rejected",
          });
        }
        if (params.source.kind === "https" && !params.source.url.toLowerCase().startsWith("https://")) {
          return errorResult("Media source must be an HTTPS URL", {
            action: params.action,
            sent: false,
            chatId: target.chatId,
            mediaType: params.media_type,
            error: "Media source must be an HTTPS URL",
            category: "telegram_rejected",
          });
        }
        const mediaResult = await sendMedia(ctx.cwd, target.chatId, params.media_type, params.source, {
          caption: params.caption,
          filename: params.filename,
        }, ctx.sessionManager.getSessionId());
        if (!mediaResult.ok) {
          const error = safeTelegramError(mediaResult.error);
          return errorResult(`Telegram media failed: ${error}`, {
            action: params.action,
            sent: false,
            chatId: target.chatId,
            mediaType: params.media_type,
            error,
            category: mediaResult.category,
          });
        }
        return textResult(`Telegram ${params.media_type} sent`, {
          action: params.action,
          sent: true,
          chatId: target.chatId,
          messageId: mediaResult.messageId,
          mediaType: mediaResult.mediaType,
          bytes: mediaResult.bytes,
          ...(mediaResult.filename ? { filename: mediaResult.filename } : {}),
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
          const error = safeTelegramError(reactionResult.error);
          return errorResult(`Telegram reaction failed: ${error}`, {
            action: params.action,
            sent: false,
            chatId: target.chatId,
            messageId: params.message_id,
            emoji: params.emoji,
            error,
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
        const error = safeTelegramError(result.error);
        return errorResult(`Telegram delivery failed: ${error}`, {
          action: params.action,
          sent: false,
          chatId: target.chatId,
          sentChunks: result.sent,
          failedChunks: result.failed,
          error,
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
        : args.action === "react"
          ? `react ${args.emoji} → ${args.chat_id}:${args.message_id}`
          : args.action === "send_choices"
            ? `choices ${args.question}`
            : `media ${args.media_type} → ${args.chat_id}`;
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