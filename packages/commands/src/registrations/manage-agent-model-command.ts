import type { ExtensionAPI, ExtensionCommandContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { COMMAND_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { ManageAgentModelWizard, type ManageAgentModelResult, type ManageAgentModelWizardOptions } from "@xzy-ai/tui";
import { createManageAgentModelController } from "./manage-agent-model.ts";

function setupTheme(theme: { fg: (color: ThemeColor, text: string) => string }): { fg: (color: string, text: string) => string } {
  return { fg: (color, text) => theme.fg(color as ThemeColor, text) };
}

/** Register the interactive agent-model management wizard. */
export function registerManageAgentModel(pi: ExtensionAPI): void {
  pi.registerCommand("manage-agent-model", {
    description: "Set or remove the model an agent runs with",
    async handler(_args: string, ctx: ExtensionCommandContext): Promise<void> {
      return processWithLog({ operation: COMMAND_OPERATIONS.MANAGE_AGENT_MODEL }, async () => {
        if (ctx.mode !== "tui" || !ctx.hasUI) {
          ctx.ui.notify("Agent model management requires an interactive TUI session", "warning");
          return;
        }
        const controller = createManageAgentModelController({ cwd: ctx.cwd, modelRegistry: ctx.modelRegistry });
        const result = await ctx.ui.custom<ManageAgentModelResult>((tui, theme, _keybindings, done) => {
          const options: ManageAgentModelWizardOptions = {
            tui,
            theme: setupTheme(theme),
            controller,
            done,
            signal: ctx.signal,
          };
          return new ManageAgentModelWizard(options);
        });
        if (result.status === "saved") ctx.ui.notify(result.message, "info");
        else if (result.status === "error") ctx.ui.notify(result.message, "error");
        else ctx.ui.notify("Agent model management cancelled", "info");
      });
    },
  });
}
