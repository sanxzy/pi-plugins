import type { ExtensionAPI, ExtensionCommandContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { COMMAND_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { ManageGoalWizard, type ManageGoalResult, type ManageGoalWizardOptions } from "@xzy-ai/tui";
import { createManageGoalController } from "./manage-goal.ts";

function setupTheme(theme: { fg: (color: ThemeColor, text: string) => string }): { fg: (color: string, text: string) => string } {
  return { fg: (color, text) => theme.fg(color as ThemeColor, text) };
}

/** Register the interactive goal management wizard. */
export function registerManageGoal(pi: ExtensionAPI): void {
  pi.registerCommand("manage-goal", {
    description: "Create, edit, pause, resume, or clear the current session goal",
    async handler(_args: string, ctx: ExtensionCommandContext): Promise<void> {
      return processWithLog({ operation: COMMAND_OPERATIONS.MANAGE_GOAL }, async () => {
        if (ctx.mode !== "tui" || !ctx.hasUI) {
          ctx.ui.notify("Goal management requires an interactive TUI session", "warning");
          return;
        }
        const controller = createManageGoalController({
          cwd: ctx.cwd,
          sessionId: ctx.sessionManager.getSessionId(),
        });
        const result = await ctx.ui.custom<ManageGoalResult>((tui, theme, _keybindings, done) => {
          const options: ManageGoalWizardOptions = {
            tui,
            theme: setupTheme(theme),
            controller,
            done,
            signal: ctx.signal,
          };
          return new ManageGoalWizard(options);
        });
        if (result.status === "saved") ctx.ui.notify(result.message, "info");
        else if (result.status === "error") ctx.ui.notify(result.message, "error");
        else ctx.ui.notify("Goal management cancelled", "info");
      });
    },
  });
}
