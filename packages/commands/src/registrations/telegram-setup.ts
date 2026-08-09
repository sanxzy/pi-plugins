import type { ExtensionAPI, ExtensionCommandContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  createTelegramSetupController,
  canonicalProjectRoot,
  type ChannelConfig,
  type ChannelManager,
  type ChannelPoller,
} from "@xzy-ai/channels";
import {
  TelegramChannelSetup,
  type TelegramChannelSetupTheme,
  type TelegramSetupResult,
} from "@xzy-ai/tui";
import { getTelegramProjectManager } from "./telegram-project.ts";
import { refreshTelegramInbound } from "./telegram-inbound.ts";

export interface TelegramSetupRegistrationDeps {
  createManager?: (projectRoot: string) => ChannelManager;
  createPoller?: (config: ChannelConfig, projectRoot: string, sessionId: string) => ChannelPoller;
}

function setupTheme(theme: { fg: (color: ThemeColor, text: string) => string }): TelegramChannelSetupTheme {
  return { fg: (color, text) => theme.fg(color as ThemeColor, text) };
}

/** Register the rerunnable, dedicated `/setup-channel-telegram` command. */
export function registerTelegramSetup(
  pi: ExtensionAPI,
  deps: TelegramSetupRegistrationDeps = {},
): void {
  pi.registerCommand("setup-channel-telegram", {
    description: "Configure and connect a Telegram bot for this project",
    async handler(_args: string, ctx: ExtensionCommandContext): Promise<void> {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui.notify("Telegram setup requires an interactive TUI session", "warning");
        return;
      }

      const projectRoot = canonicalProjectRoot(ctx.cwd);
      const sessionId = ctx.sessionManager?.getSessionId?.() ?? "setup";
      const manager = getTelegramProjectManager({
        projectRoot,
        sessionId,
        createManager: deps.createManager,
        createPoller: deps.createPoller,
      });
      const controller = createTelegramSetupController({
        projectRoot,
        manager,
        onConfigChanged: (config) => refreshTelegramInbound(projectRoot, config),
      });
      const result = await ctx.ui.custom<TelegramSetupResult>(
        (tui, theme, _keybindings, done) => new TelegramChannelSetup({
          tui,
          theme: setupTheme(theme),
          controller,
          done,
          signal: ctx.signal,
        }),
      );

      if (result.status === "saved") {
        ctx.ui.notify(result.message, "info");
      } else if (result.status === "error") {
        ctx.ui.notify(result.message, "error");
      } else {
        ctx.ui.notify("Telegram setup cancelled", "info");
      }
    },
  });
}
