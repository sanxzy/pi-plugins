import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  AgentManager,
  MANAGER_SHORTCUT,
  type AgentManagerTheme,
  type ManagerRow,
  type ManagerView,
} from "@xzy-ai/tui";
import { getChildPool, scopeRegistry } from "@xzy-ai/runtime";

/**
 * Register the agent-manager shortcut.
 *
 * The manager is TUI-only: registration happens inside `session_start` so the
 * shortcut exists only for TUI sessions (non-TUI modes never see it, and their
 * workflows behave exactly as before). The host runs `setupExtensionShortcuts`
 * after `session_start`, so a shortcut registered here is picked up on every
 * session bind. A fixed `Ctrl+Shift+A` opens the centered modal, the same
 * shortcut and `Escape` close it, and the host composer draft is restored after
 * close. Repeated opens are guarded by the active-manager singleton in the
 * shared pool so the same overlay is never mounted twice.
 */
export function registerManagerShortcut(pi: ExtensionAPI): void {
  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    pi.registerShortcut(MANAGER_SHORTCUT, {
      description: "Open the agent manager",
      handler: (handlerCtx: ExtensionContext) => openManager(handlerCtx),
    });
  });
}

/** Singleton slot reused across handler invocations of the same session. */
const activeManager = new WeakMap<object, AgentManager>();

function openManager(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui" || !ctx.hasUI) return;

  const pool = getChildPool(ctx.cwd, ctx.sessionManager.getSessionId());
  const existing = activeManager.get(pool);
  if (existing) {
    existing.close("shortcut");
    return;
  }

  const draft = ctx.ui.getEditorText();
  ctx.ui.custom(
    (tui, theme, _keybindings, done) => {
      let manager: AgentManager;
      manager = new AgentManager({
        tui,
        theme: managerTheme(theme),
        view: buildView(ctx, pool),
        onEnter: (row) => {
          manager.pushView(buildViewForSession(ctx, pool, row.sessionId));
        },
        done: (reason) => {
          // Every close path, including the opening shortcut pressed again,
          // restores the exact composer draft captured before mounting.
          ctx.ui.setEditorText(draft);
          activeManager.delete(pool);
          done(reason);
        },
      });
      activeManager.set(pool, manager);
      return manager;
    },
    { overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%" } },
  );
}

/** The host Theme surface adapted to the manager's color contract. */
function managerTheme(theme: Theme): AgentManagerTheme {
  return {
    fg: (color: string, text: string) =>
      theme.fg(
        (color as Parameters<Theme["fg"]>[0]) || "muted",
        text,
      ),
  };
}

/** Project the live session scope into display rows, newest first. */
function buildView(ctx: ExtensionContext, pool: ReturnType<typeof getChildPool>): ManagerView {
  return buildViewForSession(ctx, pool, ctx.sessionManager.getSessionId());
}

/** Project one session's descendant scope into a navigable child view. */
function buildViewForSession(
  ctx: ExtensionContext,
  pool: ReturnType<typeof getChildPool>,
  sessionId: string,
): ManagerView {
  const rootSessionId = ctx.sessionManager.getSessionId();
  const rows: ManagerRow[] = [
    {
      rowId: sessionId,
      sessionId,
      status: sessionId === rootSessionId ? "active" : "running",
      description: sessionId === rootSessionId ? "Current session" : "Session",
      durationMs: 0,
      depth: 0,
      enterable: false,
    },
    ...scopeRegistry(pool.scopedRegistry, sessionId, pool.liveChildren).map((row) =>
      toManagerRow(row),
    ),
  ];
  return { scopeSessionId: sessionId, rows };
}

function toManagerRow(row: {
  jobId: string;
  sessionId: string;
  status: ManagerRow["status"];
  description: string;
  durationMs: number;
  depth: number;
  enterable: boolean;
}): ManagerRow {
  return {
    rowId: row.jobId,
    sessionId: row.sessionId,
    status: row.status,
    description: row.description,
    durationMs: row.durationMs,
    depth: row.depth + 1,
    enterable: row.enterable,
  };
}
