import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { COMMAND_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { ManageModelGroupsWizard } from "@xzy-ai/tui";
import { getModelGroups, saveModelGroups, deriveGroupContextWindow } from "@xzy-ai/runtime";

export function registerManageModelGroupsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("c2-manage-model-groups", {
    description: "Manage model groups (create/edit/delete/activate)",
    async handler(_args: string, ctx: ExtensionCommandContext): Promise<void> {
      return processWithLog({ operation: COMMAND_OPERATIONS.MANAGE_AGENT_MODEL }, async () => {
        if (ctx.mode !== "tui" || !ctx.hasUI) {
          ctx.ui.notify("Model group management requires an interactive TUI session", "warning");
          return;
        }
        const file = getModelGroups();
        const registry = ctx.modelRegistry as unknown as { getAvailable(): Array<{ provider: string; id: string; contextWindow?: number }> } | undefined;
        const groups = file.groups.map((g) => ({
          ...g,
          contextWindow: registry ? deriveGroupContextWindow(g, registry.getAvailable()) : undefined,
        }));
        await ctx.ui.custom<void>((_tui, _theme, _keybindings, done) => {
          const wizard = new ManageModelGroupsWizard({
            groups,
            activeGroupId: file.activeGroupId,
            onActivate: (id: string) => {
              saveModelGroups({ groups: file.groups, activeGroupId: id });
              ctx.ui.notify(`Active model group set to ${id}`, "info");
            },
            onClose: () => done(undefined),
          });
          return wizard;
        });
      });
    },
  });
}
