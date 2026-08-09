import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  canSendTelegram,
  recordTelegramToolSend,
  sendTelegramChoice,
  sendTelegramMessage,
  type OutboundTextResult,
} from "@xzy-ai/channels";
import { saveConnectionMarker, validateChoices } from "@xzy-ai/channels";
import { telegramChatParams, type TelegramChatParams, type TelegramChoice } from "../tools.ts";
import { errorResult, textResult } from "../results.ts";

export interface TelegramChatDetails {
  sent: boolean;
  message: string;
  chunks?: number;
  choices?: number;
  waiting?: boolean;
  error?: string;
}

export interface TelegramChoiceSendResult {
  ok: boolean;
  sent?: number;
  error?: string;
}

export interface TelegramChatDeps {
  /** Injectable send seam so tests verify the gate without creating a bot. */
  send?: (projectRoot: string, message: string) => Promise<OutboundTextResult>;
  /** Injectable choice sender; when choices are supplied this is used instead. */
  sendChoice?: (projectRoot: string, message: string, choices: TelegramChoice[]) => Promise<TelegramChoiceSendResult>;
  /** Injectable host follow-up so the choice answer re-enters the model. */
  sendFollowUp?: (content: string) => Promise<void>;
  /** Injectable marker writer so a choice answer marks Telegram as the origin. */
  setTelegramMarker?: () => void | Promise<void>;
}

/** Register the Telegram communication/reporting tool (text or inline choices). */
export function registerTelegramChatTool(pi: ExtensionAPI, deps: TelegramChatDeps = {}): void {
  const send = deps.send ?? sendTelegramMessage;
  pi.registerTool({
    name: "user_telegram_chat",
    label: "Telegram",
    description: "Send a communication or report to the configured Telegram chat when the latest user connection is Telegram.",
    parameters: telegramChatParams,
    async execute(
      _toolCallId: string,
      params: TelegramChatParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<TelegramChatDetails>> {
      if (!canSendTelegram(ctx.cwd)) {
        return errorResult("Telegram delivery is unavailable because the latest user connection is not Telegram", {
          sent: false,
          message: params.message,
          error: "connection_not_telegram",
        });
      }
      if (params.choices !== undefined) {
        const validationError = validateChoices(params.choices);
        if (validationError !== undefined) {
          return errorResult(`Telegram choices failed: ${validationError}`, {
            sent: false,
            message: params.message,
            choices: params.choices.length,
            error: validationError,
          });
        }
        const sendChoice =
          deps.sendChoice ??
          ((projectRoot: string, message: string, choices: TelegramChoice[]) =>
            sendTelegramChoice(projectRoot, message, choices, {
              sendFollowUp:
                deps.sendFollowUp ??
                (async (content: string) => {
                  pi.sendUserMessage(content, { deliverAs: "followUp" });
                }),
              setTelegramMarker:
                deps.setTelegramMarker ??
                (() => {
                  saveConnectionMarker(ctx.cwd, {
                    lastConnection: "telegram",
                    updatedAt: new Date().toISOString(),
                  });
                }),
            }));
        const result = await sendChoice(ctx.cwd, params.message, params.choices);
        if (!result.ok) {
          return errorResult(`Telegram choices failed: ${result.error}`, {
            sent: false,
            message: params.message,
            choices: params.choices.length,
            error: result.error,
          });
        }
        // The question carries inline choices; the answer arrives later through
        // a callback, so this is not a final-forward candidate.
        return textResult(
          `Telegram question sent with ${params.choices.length} choices; waiting for an answer.`,
          {
            sent: true,
            message: params.message,
            choices: params.choices.length,
            waiting: true,
          },
        );
      }
      const result = await send(ctx.cwd, params.message);
      if (!result.ok) {
        return errorResult(`Telegram delivery failed: ${result.error}`, {
          sent: false,
          message: params.message,
          error: result.error,
        });
      }
      // Record the exact text so automatic final forwarding does not duplicate it.
      recordTelegramToolSend(ctx.cwd, params.message);
      return textResult(`Telegram message sent (${result.sent} message${result.sent === 1 ? "" : "s"})`, {
        sent: true,
        message: params.message,
        chunks: result.sent,
      });
    },
    renderCall(args: TelegramChatParams, theme) {
      const text = theme.fg("toolTitle", theme.bold("user_telegram_chat ")) + theme.fg("muted", args.message);
      return new Text(text, 0, 0);
    },
    renderResult(result: AgentToolResult<TelegramChatDetails>, _options, theme) {
      const details = result.details;
      if (!details?.sent) {
        return new Text(theme.fg("warning", "Telegram delivery unavailable"), 0, 0);
      }
      const suffix = details.chunks && details.chunks > 1 ? ` (${details.chunks} chunks)` : "";
      return new Text(theme.fg("success", `✓ Sent to Telegram${suffix}`), 0, 0);
    },
  });
}
