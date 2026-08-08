import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  AgentActivityTicker,
  AgentManager,
  MANAGER_SHORTCUT,
  type AgentActivityItem,
  type AgentActivitySource,
  type AgentManagerTheme,
  type ManagerRow,
  type ManagerView,
} from "@xzy-ai/tui";
import { getChildPool, scopeRegistry, type LiveActivitySource } from "@xzy-ai/runtime";

/** Widget key that keeps the ticker mounted across re-renders. */
export const AGENT_TICKER_WIDGET_KEY = "pi-code-agent-ticker";

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

  // A host UI reset (reload or session replacement) pops the overlay without
  // calling the mounted component's `dispose()`, so the manager registration
  // releases modal subscriptions itself. Disposal is strictly UI teardown: it
  // never aborts a child and never invokes the shutdown interruption sweep.
  pi.on("session_shutdown", (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
    const pool = getChildPool(ctx.cwd);
    // Child AgentSessions emit their own `quit` shutdown after settling. Only
    // the root host session owns this modal; a child teardown must not close a
    // manager that is viewing another live child.
    if (pool.registry.get(ctx.sessionManager.getSessionId()) !== undefined) return;
    activeManager.get(pool)?.dispose();
    activeManager.delete(pool);
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
        refreshView: (sessionId) => buildViewForSession(ctx, pool, sessionId),
        onEnter: (row) => {
          const control = pool.liveChildren.get(row.rowId);
          if (!control?.live) {
            manager.setHint("This session is no longer available.");
            return;
          }
          manager.pushLiveView({
            sessionId: row.sessionId,
            rowId: row.rowId,
            description: row.description,
            live: control.live,
          });
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

/**
 * Register the agent-activity news ticker above the composer.
 *
 * TUI-only, mounted once per session as a `setWidget` above the editor. The
 * widget shows the latest activity of each running background agent as a
 * continuously scrolling single line, so the user sees sub-agents progressing
 * without opening the manager. The widget disappears entirely when no agents
 * run. On host reset the widget is cleared so it never leaks across a session
 * replacement.
 */
export function registerAgentTicker(pi: ExtensionAPI): void {
  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    const source = createActivitySource(ctx);
    ctx.ui.setWidget(AGENT_TICKER_WIDGET_KEY, (tui, theme) => {
      const ticker = new AgentActivityTicker({
        tui,
        theme: { fg: (color: string, text: string) => theme.fg(color as Parameters<Theme["fg"]>[0] || "muted", text) },
        source,
      });
      // Keep the widget alive for the widget's host-managed lifetime; the TUI
      // disposes it on reset. The local handle is only for symmetry with the
      // manager registration's explicit teardown.
      return ticker;
    });
  });

  pi.on("session_shutdown", (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    // Child AgentSessions emit their own `quit` shutdown after settling; only
    // the root host session owns the widget, so a child teardown leaves it up.
    const pool = getChildPool(ctx.cwd);
    if (pool.registry.get(ctx.sessionManager.getSessionId()) !== undefined) return;
    ctx.ui.setWidget(AGENT_TICKER_WIDGET_KEY, undefined);
  });
}

/** Bridge the pool's live activity into the ticker's minimal source surface. */
function createActivitySource(ctx: ExtensionContext): AgentActivitySource {
  const pool = getChildPool(ctx.cwd, ctx.sessionManager.getSessionId());
  const liveActivity = pool.liveActivity as LiveActivitySource;
  return {
    getItems(): readonly AgentActivityItem[] {
      const items: AgentActivityItem[] = [];
      for (const [jobId, control] of pool.liveChildren) {
        const snapshot = control.live?.snapshot;
        if (!snapshot) continue;
        const last = snapshot.transcript[snapshot.transcript.length - 1];
        if (!last) continue;
        const text = last.kind === "tool" ? `⌘ ${last.toolName ?? "tool"}` : `· ${last.text}`;
        items.push({ jobId, text });
      }
      return items;
    },
    subscribe(listener: () => void): () => void {
      return liveActivity.subscribe(listener);
    },
  };
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
