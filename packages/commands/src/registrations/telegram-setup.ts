import type { ExtensionAPI, ExtensionCommandContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { COMMAND_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import {
  createTelegramSetupController,
  canonicalProjectRoot,
  type ChannelConfig,
  type ChannelManager,
  type ChannelPoller,
  type TelegramMenuCommandSource,
} from "@xzy-ai/channels";
import {
  TelegramSetupWizard,
  type TelegramSetupWizardTheme,
  type TelegramSetupResult,
} from "@xzy-ai/tui";
import { getTelegramProjectManager } from "./telegram-project.ts";
import { refreshTelegramInbound } from "./telegram-inbound.ts";

export interface TelegramSetupRegistrationDeps {
  createManager?: (projectRoot: string) => ChannelManager;
  createPoller?: (config: ChannelConfig, projectRoot: string, sessionId: string) => ChannelPoller;
  /** Read the current Pi command/prompt/skill catalog for menu sync during setup. */
  getCommands?: () => readonly TelegramMenuCommandSource[];
}

function setupTheme(theme: { fg: (color: ThemeColor, text: string) => string }): TelegramSetupWizardTheme {
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
      return processWithLog({ operation: COMMAND_OPERATIONS.SETUP_CHANNEL }, async () => {
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
        getCommands: deps.getCommands,
      });
      const controller = createTelegramSetupController({
        projectRoot,
        manager,
        onConfigChanged: (config) => refreshTelegramInbound(projectRoot, config),
      });
      const result = await ctx.ui.custom<TelegramSetupResult>(
        (tui, theme, _keybindings, done) => new TelegramSetupWizard({
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
      });
    },
  });
}
