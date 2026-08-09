import type { ExtensionAPI, ExtensionCommandContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  createChannelLogger,
  createChannelManager,
  createTelegramSetupController,
  canonicalProjectRoot,
  createTelegramTransport,
  type ChannelConfig,
  type ChannelPoller,
} from "@xzy-ai/channels";
import {
  TelegramChannelSetup,
  type TelegramChannelSetupTheme,
  type TelegramSetupResult,
} from "@xzy-ai/tui";

export interface TelegramSetupRegistrationDeps {
  createManager?: (projectRoot: string) => ReturnType<typeof createChannelManager>;
  createPoller?: (config: ChannelConfig) => ChannelPoller;
}

function setupTheme(theme: { fg: (color: ThemeColor, text: string) => string }): TelegramChannelSetupTheme {
  return { fg: (color, text) => theme.fg(color as ThemeColor, text) };
}

/** Per-project manager registry so rerunning setup reuses the active listener. */
const managersByProject = new Map<string, ReturnType<typeof createChannelManager>>();

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
      let manager = managersByProject.get(projectRoot);
      if (!manager) {
        manager = deps.createManager?.(projectRoot) ?? createChannelManager({
          projectRoot,
          createPoller: deps.createPoller ?? ((config: ChannelConfig) => {
            const loggerResult = createChannelLogger({ projectRoot, sessionId: ctx.sessionManager.getSessionId() });
            if (!loggerResult.ok) {
              throw new Error("Unable to create Telegram connection log");
            }
            return createTelegramTransport({ logger: loggerResult.value });
          }),
        });
        managersByProject.set(projectRoot, manager);
      }
      const controller = createTelegramSetupController({ projectRoot, manager });
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