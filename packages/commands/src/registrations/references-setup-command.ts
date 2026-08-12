import type { ExtensionAPI, ExtensionCommandContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { ReferencesSetupWizard, type ReferencesSetupResult, type ReferencesSetupWizardOptions } from "@xzy-ai/tui";
import { createReferenceCatalog } from "@xzy-ai/runtime";
import { createReferencesSetupController } from "./references-setup.ts";

function setupTheme(theme: { fg: (color: ThemeColor, text: string) => string }): { fg: (color: string, text: string) => string } {
  return { fg: (color, text) => theme.fg(color as ThemeColor, text) };
}

/** Register the global references setup wizard. */
export function registerReferencesSetup(pi: ExtensionAPI): void {
  pi.registerCommand("setup-references", {
    description: "Configure global local and Git references",
    async handler(_args: string, ctx: ExtensionCommandContext): Promise<void> {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui.notify("References setup requires an interactive TUI session", "warning");
        return;
      }
      const controller = createReferencesSetupController({ catalog: createReferenceCatalog() });
      const result = await ctx.ui.custom<ReferencesSetupResult>((tui, theme, _keybindings, done) => {
        const options: ReferencesSetupWizardOptions = {
          tui,
          theme: setupTheme(theme),
          controller,
          done,
          signal: ctx.signal,
        };
        return new ReferencesSetupWizard(options);
      });
      if (result.status === "saved") ctx.ui.notify(result.message, "info");
      else if (result.status === "error") ctx.ui.notify(result.message, "error");
      else ctx.ui.notify("References setup cancelled", "info");
    },
  });
}
