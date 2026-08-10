/**
 * `/clear-channel-telegram` command registration.
 *
 * Stops the active Telegram listener through the shared project manager, then
 * removes the persisted channel config and runtime cursor. TUI-only: the
 * command cannot run from Telegram itself (it would disconnect the channel it
 * arrived on) and requires an interactive confirmation-free flow.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  canonicalProjectRoot,
  clearChannelConfig,
  readChannelConfig,
  type ChannelManager,
  type ChannelPoller,
} from "@xzy-ai/channels";
import { getTelegramProjectManager } from "./telegram-project.ts";

export interface TelegramClearRegistrationDeps {
  createManager?: (projectRoot: string) => ChannelManager;
  createPoller?: (config: Parameters<ChannelPoller["start"]>[0], projectRoot: string, sessionId: string) => ChannelPoller;
}

/** Register the rerunnable `/clear-channel-telegram` command. */
export function registerTelegramClear(
  pi: ExtensionAPI,
  deps: TelegramClearRegistrationDeps = {},
): void {
  pi.registerCommand("clear-channel-telegram", {
    description: "Disconnect and remove the Telegram channel setup for this project",
    async handler(_args: string, ctx: ExtensionCommandContext): Promise<void> {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui.notify("Telegram channel clearing requires an interactive TUI session", "warning");
        return;
      }

      const projectRoot = canonicalProjectRoot(ctx.cwd);
      const sessionId = ctx.sessionManager?.getSessionId?.() ?? "setup";

      const channel = readChannelConfig(projectRoot);
      if (!channel.ok) {
        ctx.ui.notify(channel.code === "missing"
          ? "No Telegram channel setup to clear"
          : "Telegram channel state is invalid; nothing was cleared", "info");
        return;
      }

      const manager = getTelegramProjectManager({
        projectRoot,
        sessionId,
        createManager: deps.createManager,
        createPoller: deps.createPoller,
      });
      await manager.stop();

      const cleared = clearChannelConfig(projectRoot);
      if (!cleared.ok) {
        ctx.ui.notify(cleared.message, "error");
        return;
      }
      ctx.ui.notify("Telegram channel setup cleared; the bot is disconnected", "info");
    },
  });
}
