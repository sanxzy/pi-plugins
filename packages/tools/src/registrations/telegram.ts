import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  canSendTelegram,
  sendTelegramMessage,
  type OutboundTextResult,
} from "@xzy-ai/channels";
import { telegramChatParams, type TelegramChatParams } from "../tools.ts";
import { errorResult, textResult } from "../results.ts";
import type { TelegramChatDetails } from "../types.ts";

export type { TelegramChatDetails } from "../types.ts";

export interface TelegramChatDeps {
  /** Injectable send seam so tests verify gating and partial results offline. */
  send?: (projectRoot: string, message: string) => Promise<OutboundTextResult>;
  /** Injectable gate seam so tests do not need filesystem state for the tool. */
  canSend?: (projectRoot: string) => boolean;
}

/** Register the parent-only text communication/reporting tool. */
export function registerTelegramChatTool(pi: ExtensionAPI, deps: TelegramChatDeps = {}): void {
  const send = deps.send ?? sendTelegramMessage;
  const canSend = deps.canSend ?? canSendTelegram;
  pi.registerTool({
    name: "user_telegram_chat",
    label: "Telegram",
    description: "Send a communication or report to the latest accepted Telegram chat when the latest user connection is Telegram.",
    parameters: telegramChatParams,
    async execute(
      _toolCallId: string,
      params: TelegramChatParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<TelegramChatDetails>> {
      if (!canSend(ctx.cwd)) {
        return errorResult("Telegram delivery is unavailable because the latest user connection is not Telegram", {
          sent: false,
          message: params.message,
          error: "connection_not_telegram",
        });
      }

      const result = await send(ctx.cwd, params.message);
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