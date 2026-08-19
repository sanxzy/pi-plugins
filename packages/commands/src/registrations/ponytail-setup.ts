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
        // Capture cwd/ui before reload: after await ctx.reload() the command ctx
        // is invalidated and any access throws "stale after session replacement".
        const cwd = ctx.cwd;
        const ui = ctx.ui;
        const reloadFn = typeof ctx.reload === "function" ? ctx.reload.bind(ctx) : undefined;
        try {
          await mutatePonytailState(sessionId, Date.now(), (state) => ({
            version: 1,
            enabled,
            tickets: state?.tickets ?? [],
          }));
        } catch {
          ui.notify("Unable to persist Ponytail state; the active session was not changed.", "error");
          return;
        }
        ui.notify(`Ponytail ${enabled ? "enable" : "disable"} choice persisted successfully.`, "info");
        markSessionReload(cwd, { silent: true });
        if (reloadFn === undefined) {
          clearSessionReload(cwd);
          ui.notify(`Session reload unavailable; the current runtime was not changed. The Ponytail ${enabled ? "enable" : "disable"} choice takes effect at the next successful reload or session start.`, "warning");
          return;
        }
        try {
          await reloadFn();
        } catch {
          clearSessionReload(cwd);
          try {
            ui.notify(`Session reload failed; the current runtime was not changed. The persisted Ponytail choice takes effect at the next successful reload or session start.`, "warning");
          } catch {
            // ui is from the stale ctx; ignore if notify throws after reload.
          }
          return;
        }
        // Do not use ctx after successful reload — it is stale. Use the
        // captured ui and swallow the stale error if the runner has already
        // invalidated it. The session_start gate will also send
        // "Your session was reloaded." via the fresh runtime.
        try {
          ui.notify("Session reload succeeded; the current runtime now reflects the persisted Ponytail choice.", "info");
        } catch {
          // Stale ctx — the reload itself already succeeded and the persisted
          // choice will be visible in the fresh session.
        }
      });
    },
  });
}
