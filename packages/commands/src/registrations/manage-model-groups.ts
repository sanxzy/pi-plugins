import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { COMMAND_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { ManageModelGroupsWizard } from "@xzy-ai/tui";

export function registerManageModelGroupsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("c2-manage-model-groups", {
    description: "Manage model groups (create/edit/delete/activate)",
    async handler(_args: string, ctx: ExtensionCommandContext): Promise<void> {
      return processWithLog({ operation: COMMAND_OPERATIONS.MANAGE_AGENT_MODEL }, async () => {
        if (ctx.mode !== "tui" || !ctx.hasUI) {
          ctx.ui.notify("Model group management requires an interactive TUI session", "warning");
          return;
        }
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
          const wizard = new ManageModelGroupsWizard({
            theme,
            onClose: () => done(undefined),
            modelRegistry: ctx.modelRegistry as unknown as { getAvailable(): Array<{ provider: string; id: string; contextWindow?: number }> },
          });
          return wizard;
        });
      });
    },
  });
}
