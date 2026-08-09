import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createBot, createSetupController, type SetupBotSurface } from "@xzy-ai/channels";
import { TelegramChannelSetup, type TelegramSetupResult } from "@xzy-ai/tui";
import { markTui } from "./connection-marker.ts";

function createSetupBot(token: string): SetupBotSurface {
  const bot = createBot(token);
  return {
    getMe: () => bot.api.getMe(),
    api: {
      setMyCommands: (commands, other) => bot.api.setMyCommands(commands, other),
    },
    start: () => bot.start(),
    stop: () => bot.stop(),
  };
}

/**
 * Register `/setup-channel-telegram`.
 *
 * The command is TUI-only: in non-TUI modes it reports an error result without
 * mounting. In TUI mode it mounts the `TelegramChannelSetup` wizard through
 * `ctx.ui.custom()` and writes the `tui` marker explicitly (registered
 * extension commands are handled before the `input` event).
 */
export function registerSetupChannelCommand(pi: ExtensionAPI): void {
  pi.registerCommand("setup-channel-telegram", {
    description: "Configure the Telegram channel: bot token, allowed chats, and default chat.",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "tui") {
        await ctx.ui.notify("Telegram setup requires the TUI.", "error");
        return;
      }
      const controller = createSetupController({
        projectRoot: ctx.cwd,
        createBot: createSetupBot,
        commands: pi.getCommands(),
      });
      await controller.stopOldListener();

      const result = await ctx.ui.custom<TelegramSetupResult>(
        (_tui, theme, _keybindings, done) =>
          new TelegramChannelSetup({
            tui: _tui,
            controller,
            theme: { fg: (color, text) => theme.fg(color as never, text) },
            done,
          }),
        { overlay: true },
      );

      if (result && result.status === "configured") {
        markTui(ctx.cwd);
        ctx.ui.notify("Telegram channel configured.", "info");
        return;
      }
      ctx.ui.notify(
        result?.status === "timeout"
          ? "Telegram setup timed out; previous configuration preserved."
          : result?.status === "error"
            ? `Telegram setup failed: ${result.error}`
            : "Telegram setup cancelled; previous configuration preserved.",
        "warning",
      );
    },
  });
}