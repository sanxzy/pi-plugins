import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { COMMAND_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import {
  DEFAULT_THINKING_REQUIRED_TURNS,
  THINKING_REQUIRED_TURNS_MAX,
  THINKING_REQUIRED_TURNS_MIN,
  getChildPool,
  loadThinkingState,
  mutateThinkingState,
  parseRequiredTurns,
} from "@xzy-ai/runtime";
import { clearSessionReload, markSessionReload } from "./session-events.ts";

const ENABLE = "Enable thinking tool";
const DISABLE = "Disable thinking tool";

export const THINKING_SETUP_REQUIRED_TURNS_DEFAULT = DEFAULT_THINKING_REQUIRED_TURNS;
export function parseThinkingRequiredTurnsInput(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const numeric = Number(trimmed);
  return parseRequiredTurns(numeric);
}

/** Register the root-session thinking tool enable/disable command. */
export function registerThinkingSetup(pi: ExtensionAPI): void {
  pi.registerCommand("setup-thinking-tool", {
    description: `Enable or disable the deep_think tool for this session (required turns ${THINKING_REQUIRED_TURNS_MIN}-${THINKING_REQUIRED_TURNS_MAX}, default ${DEFAULT_THINKING_REQUIRED_TURNS})`,
    async handler(_args: string, ctx: ExtensionCommandContext): Promise<void> {
      return processWithLog({ operation: COMMAND_OPERATIONS.SETUP_THINKING }, async () => {
        if (ctx.mode !== "tui" || !ctx.hasUI) {
          ctx.ui.notify("Thinking tool setup requires an interactive TUI session", "warning");
          return;
        }
        const sessionId = ctx.sessionManager?.getSessionId?.();
        if (typeof sessionId !== "string") {
          ctx.ui.notify("Thinking tool setup is available only in a root session", "warning");
          return;
        }
        const pool = getChildPool(ctx.cwd, sessionId);
        if (!pool.isRootSession(sessionId)) {
          ctx.ui.notify("Thinking tool setup is available only in a root session", "warning");
          return;
        }
        const current = loadThinkingState(sessionId, Date.now());
        const currentTurns = current?.requiredTurns ?? DEFAULT_THINKING_REQUIRED_TURNS;
        const status = current?.enabled === true ? `enabled (required turns: ${currentTurns})` : "disabled";
        const selected = await ctx.ui.select(`Thinking tool is currently ${status}. Choose an action:`, [ENABLE, DISABLE]);
        if (selected !== ENABLE && selected !== DISABLE) {
          ctx.ui.notify("Thinking tool setup cancelled", "info");
          return;
        }
        const enabled = selected === ENABLE;
        let requiredTurns = current?.requiredTurns ?? DEFAULT_THINKING_REQUIRED_TURNS;
        if (enabled) {
          const rawArg = _args.trim().split(/\s+/)[0] ?? "";
          if (rawArg.length > 0) {
            const parsedArg = parseThinkingRequiredTurnsInput(rawArg);
            if (parsedArg === undefined) {
              ctx.ui.notify(`Invalid required turns "${rawArg}": must be an integer between ${THINKING_REQUIRED_TURNS_MIN} and ${THINKING_REQUIRED_TURNS_MAX}.`, "error");
              return;
            }
            requiredTurns = parsedArg;
          } else if (typeof (ctx.ui as unknown as { input?: unknown }).input === "function") {
            const input = await (ctx.ui as unknown as { input: (title: string, placeholder?: string) => Promise<string | undefined> }).input(
              `Required deep_think turns (${THINKING_REQUIRED_TURNS_MIN}-${THINKING_REQUIRED_TURNS_MAX})`,
              String(requiredTurns),
            );
            if (input === undefined) {
              ctx.ui.notify("Thinking tool setup cancelled", "info");
              return;
            }
            const trimmed = input.trim();
            if (trimmed.length > 0) {
              const parsed = parseThinkingRequiredTurnsInput(trimmed);
              if (parsed === undefined) {
                ctx.ui.notify(`Invalid required turns "${input}": must be an integer between ${THINKING_REQUIRED_TURNS_MIN} and ${THINKING_REQUIRED_TURNS_MAX}.`, "error");
                return;
              }
              requiredTurns = parsed;
            }
          }
        }
        const cwd = ctx.cwd;
        const ui = ctx.ui;
        const reloadFn = typeof ctx.reload === "function" ? ctx.reload.bind(ctx) : undefined;
        try {
          await mutateThinkingState(sessionId, Date.now(), (state) => ({
            version: 1,
            enabled,
            requiredTurns,
            scratchpad: state?.scratchpad ?? [],
            scratchpads: state?.scratchpads ?? {},
          }));
        } catch {
          ui.notify("Unable to persist thinking tool state; the active session was not changed.", "error");
          return;
        }
        ui.notify(`Thinking tool ${enabled ? "enable" : "disable"} choice persisted successfully.`, "info");
        markSessionReload(cwd, { silent: true });
        if (reloadFn === undefined) {
          clearSessionReload(cwd);
          ui.notify(`Session reload unavailable; the current runtime was not changed. The thinking tool ${enabled ? "enable" : "disable"} choice takes effect at the next successful reload or session start.`, "warning");
          return;
        }
        try {
          await reloadFn();
        } catch {
          clearSessionReload(cwd);
          try {
            ui.notify(`Session reload failed; the current runtime was not changed. The persisted thinking tool choice takes effect at the next successful reload or session start.`, "warning");
          } catch {
            // ui is from the stale ctx; ignore if notify throws after reload.
          }
          return;
        }
        try {
          ui.notify("Session reload succeeded; the current runtime now reflects the persisted thinking tool choice.", "info");
        } catch {
          // Stale ctx — the reload itself already succeeded
        }
      });
    },
  });
}
