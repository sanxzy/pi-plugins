import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { COMMAND_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { getChildPool, loadPonytailState, mutatePonytailState } from "@xzy-ai/runtime";
import { clearSessionReload, markSessionReload } from "./session-events.ts";

const ENABLE = "Enable Ponytail";
const DISABLE = "Disable Ponytail";

/** Register the root-session Ponytail enable/disable command. */
export function registerPonytailSetup(pi: ExtensionAPI): void {
  pi.registerCommand("setup-ponytail", {
    description: "Enable or disable Ponytail write/edit authorization for this session",
    async handler(_args: string, ctx: ExtensionCommandContext): Promise<void> {
      return processWithLog({ operation: COMMAND_OPERATIONS.SETUP_PONYTAIL }, async () => {
        if (ctx.mode !== "tui" || !ctx.hasUI) {
          ctx.ui.notify("Ponytail setup requires an interactive TUI session", "warning");
          return;
        }
        const sessionId = ctx.sessionManager?.getSessionId?.();
        if (typeof sessionId !== "string") {
          ctx.ui.notify("Ponytail setup is available only in a root session", "warning");
          return;
        }
        const pool = getChildPool(ctx.cwd, sessionId);
        if (!pool.isRootSession(sessionId)) {
          ctx.ui.notify("Ponytail setup is available only in a root session", "warning");
          return;
        }
        const current = loadPonytailState(sessionId, Date.now());
        const selected = await ctx.ui.select(`Ponytail is currently ${current?.enabled === true ? "enabled" : "disabled"}. Choose an action:`, [ENABLE, DISABLE]);
        if (selected !== ENABLE && selected !== DISABLE) {
          ctx.ui.notify("Ponytail setup cancelled", "info");
          return;
        }
        const enabled = selected === ENABLE;
        try {
          await mutatePonytailState(sessionId, Date.now(), (state) => ({
            version: 1,
            enabled,
            tickets: state?.tickets ?? [],
          }));
        } catch {
          ctx.ui.notify("Unable to persist Ponytail state; the active session was not changed.", "error");
          return;
        }
        markSessionReload(ctx.cwd);
        try {
          await ctx.reload();
          ctx.ui.notify(`Ponytail ${enabled ? "enabled" : "disabled"}; the session was reloaded.`, "info");
        } catch {
          clearSessionReload(ctx.cwd);
          ctx.ui.notify(`Ponytail ${enabled ? "enabled" : "disabled"} was persisted, but reload failed; the current runtime was not changed.`, "warning");
        }
      });
    },
  });
}
