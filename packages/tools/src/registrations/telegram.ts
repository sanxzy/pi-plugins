import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { canSendTelegram, recordTelegramToolSend, sendTelegramMessage, type OutboundTextResult } from "@xzy-ai/channels";
import { telegramChatParams, type TelegramChatParams } from "../tools.ts";
import { errorResult, textResult } from "../results.ts";

export interface TelegramChatDetails {
  sent: boolean;
  message: string;
  chunks?: number;
  error?: string;
}

export interface TelegramChatDeps {
  /** Injectable send seam so tests verify the gate without creating a bot. */
  send?: (projectRoot: string, message: string) => Promise<OutboundTextResult>;
}

/** Register the text-only Telegram communication/reporting tool. */
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
