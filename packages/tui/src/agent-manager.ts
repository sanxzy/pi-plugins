import {
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { AgentLiveSession } from "./agent-manager-live.ts";
import { fitPanelToHeight, renderBorderedPanel, statusIcon } from "./agent-manager-chrome.ts";

/** Status values rendered by the manager, including the active host session. */
export type ManagerStatus =
  | "active"
  | "created"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "stopped"
  | "aborted";

/** A display row projected from the runtime scope API. */
export interface ManagerRow {
  readonly rowId: string;
  readonly sessionId: string;
  readonly status: ManagerStatus;
  readonly description: string;
  readonly durationMs: number;
  readonly depth: number;
  readonly enterable: boolean;
}

/** A manager tree view; rows are already in depth-first display order. */
export interface ManagerView {
  readonly scopeSessionId: string;
  readonly rows: readonly ManagerRow[];
}

export interface AgentManagerTheme {
  fg: (color: string, text: string) => string;
}

export interface AgentManagerOptions {
  tui: TUI;
  theme: AgentManagerTheme;
  view: ManagerView;
  done: (reason: "escape" | "shortcut" | "back") => void;
  onEnter?: (row: ManagerRow) => void;
  /**
   * Re-project a live scope into a fresh display view.
   *
   * Supplied by the host so re-entering a settled child's tree reflects its
   * now-terminal status without leaking pool or registry state into the TUI.
   * Falls back to the captured view when absent.
   */
  refreshView?: (sessionId: string) => ManagerView;
}

const INDENT_WIDTH = 3;

/** Fixed shortcut registered by the host composition root. */
export const MANAGER_SHORTCUT = "ctrl+shift+a" as const;

/** Centered overlay sizing used by the host registration. */
export const MANAGER_OVERLAY_OPTIONS = {
  overlay: true,
  overlayOptions: {
    anchor: "center" as const,
    width: "80%" as const,
    maxHeight: "80%" as const,
  },
};

/**
 * Focused tree component for browsing the current session's descendant jobs.
 *
 * The component owns the cursor and return stack. It deliberately receives
 * immutable display views from the host, so no PI session handle or filesystem
 * state leaks into the TUI package.
 */
export class AgentManager implements Component {
  private readonly tui: TUI;
  private readonly theme: AgentManagerTheme;
  private readonly done: AgentManagerOptions["done"];
  private readonly onEnter?: AgentManagerOptions["onEnter"];
  private readonly refreshView?: AgentManagerOptions["refreshView"];
  private readonly returnStack: Array<{ view: ManagerView; selectedIndex: number }> = [];
  private view: ManagerView;
  private selectedIndex = 0;
  private cachedLines: string[] | undefined;
  private cachedWidth = -1;
  private cachedHeight = -1;
  private hint: string | undefined;
  private settled = false;
  private liveView: { sessionId: string; rowId?: string; description: string; live: AgentLiveSession } | undefined;
  private liveUnsubscribe: (() => void) | undefined;
  private draftInput = "";

  constructor(options: AgentManagerOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.done = options.done;
    this.onEnter = options.onEnter;
    this.refreshView = options.refreshView;
    this.view = options.view;
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, Math.floor(width));
    if (!this.liveView) return this.renderTree(renderWidth);
    return this.renderLive(renderWidth);
  }

  private renderTree(renderWidth: number): string[] {
    // The cache is width- and height-keyed so a terminal resize (width change
    // re-wraps rows; a same-width height shrink must re-clamp the panel) always
    // re-renders the tree.
    const fitHeight = overlayHeight(this.tui.terminal?.rows ?? 24);
    if (this.cachedLines && this.cachedWidth === renderWidth && this.cachedHeight === fitHeight) {
      return this.cachedLines;
    }
    this.cachedWidth = renderWidth;
    this.cachedHeight = fitHeight;

    const body: string[] = [];
    if (this.view.rows.length === 0) {
      body.push(this.theme.fg("muted", "No child sessions yet"));
      body.push(this.theme.fg("dim", "Sessions spawned by this session will appear here."));
    } else {
      const isLast = this.computeLastSiblingFlags();
      const ancestorStack: number[] = [];
      for (let index = 0; index < this.view.rows.length; index++) {
        const row = this.view.rows[index]!;
        while (ancestorStack.length > row.depth) ancestorStack.pop();
        const prefix = this.treePrefix(row.depth, isLast, ancestorStack, index);
        const cursor = index === this.selectedIndex ? this.theme.fg("accent", "▸ ") : "  ";
        const indicator = this.statusIndicator(row.status);
        const duration = formatDuration(row.durationMs);
        const entrySuffix = row.enterable && row.status === "running" ? this.theme.fg("dim", "  enter") : "";
        const bodyText = `${prefix}${indicator} ${row.description} (${duration})${entrySuffix}`;
        const available = Math.max(1, renderWidth - visibleWidth(cursor));
        body.push(cursor + truncateToWidth(bodyText, available));
        ancestorStack.push(index);
      }
    }

    const footer = this.hint
      ? `${this.theme.fg("warning", this.hint)}  ${this.theme.fg("dim", "↑/↓ move • Enter view • ← back • Esc close")}`
      : this.theme.fg("dim", "↑/↓ move • Enter view • ← back • Esc close");

    const panel = renderBorderedPanel(this.theme, {
      width: renderWidth,
      title: `${this.theme.fg("accent", "Agent Manager")} ─ ${this.theme.fg("dim", `Session ${this.view.scopeSessionId}`)}`,
      status: this.statusBar(),
      body,
      footer,
    });
    this.cachedLines = fitPanelToHeight(panel, fitHeight);
    return this.cachedLines;
  }

  private statusBar(): string {
    const rows = this.view.rows;
    if (rows.length === 0) return this.theme.fg("dim", "No child sessions");
    const counts = new Map<ManagerStatus, number>();
    for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
    const parts: string[] = [
      this.theme.fg("accent", `${rows.length} sessions`),
    ];
    const running = counts.get("running") ?? 0;
    if (running > 0) parts.push(`${running} running`);
    const completed = counts.get("completed") ?? 0;
    if (completed > 0) parts.push(`${completed} done`);
    const failed = counts.get("failed") ?? 0;
    if (failed > 0) parts.push(this.theme.fg("error", `${failed} failed`));
    const pending = (counts.get("queued") ?? 0) + (counts.get("created") ?? 0);
    if (pending > 0) parts.push(`${pending} queued`);
    const cancelled = (counts.get("cancelled") ?? 0) + (counts.get("interrupted") ?? 0) + (counts.get("stopped") ?? 0) + (counts.get("aborted") ?? 0);
    if (cancelled > 0) parts.push(`${cancelled} cancelled`);
    return parts.join("  •  ");
  }

  private renderLive(renderWidth: number): string[] {
    // The tree cache is stale as soon as a live view is active.
    this.cachedLines = undefined;
    this.cachedWidth = -1;
    const live = this.liveView!.live;
    const viewportRows = Math.max(1, this.tui.terminal?.rows ?? 24);
    const snapshot = live.snapshot;
    const body: string[] = [];
    body.push(this.theme.fg("dim", this.liveView!.description));
    body.push(this.theme.fg("dim", "Transcript"));

    const transcriptBudget = Math.max(1, viewportRows - 8 - (this.hint ? 1 : 0) - (this.draftInput && !snapshot.settled ? 1 : 0));
    const entries = [...snapshot.transcript].slice(-transcriptBudget);
    if (entries.length === 0) {
      body.push(this.theme.fg("dim", "No activity yet."));
    } else {
      for (const entry of entries) {
        const icon = entry.kind === "tool" ? "⌘" : entry.role === "user" ? "›" : "·";
        const text = entry.kind === "tool"
          ? `${icon} ${entry.toolName ?? "tool"}${entry.complete ? "" : " (running)"}`
          : `${icon} ${entry.role === "user" ? "you: " : ""}${entry.text}`;
        body.push(this.theme.fg(entry.kind === "tool" ? "muted" : "text", text));
      }
    }

    if (this.hint) body.push(this.theme.fg("warning", this.hint));
    if (!snapshot.settled && this.draftInput) {
      body.push(this.theme.fg("accent", `steer> ${this.draftInput}`));
    }

    const footer = snapshot.settled
      ? this.theme.fg("dim", `${statusIcon(snapshot.status)} ${snapshot.status} • read-only • ← back • Esc close`)
      : this.theme.fg("dim", "Type to steer this child • Enter send • ← back • Esc close");
    const status = `${this.theme.fg(statusColor(snapshot.status), statusIcon(snapshot.status))} ${snapshot.status}  •  ${snapshot.transcript.length} events`;
    const panel = renderBorderedPanel(this.theme, {
      width: renderWidth,
      title: `${this.theme.fg("accent", "Child Session")} ─ ${this.theme.fg("dim", this.liveView!.description)}`,
      status,
      body,
      footer,
    });
    return fitPanelToHeight(panel, viewportRows);
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = -1;
    this.cachedHeight = -1;
  }

  handleInput(data: string): void {
    if (this.settled) return;
    if (this.liveView) {
      this.handleLiveInput(data);
      return;
    }

    if (matchesKey(data, Key.ctrlShift("a"))) {
      this.finish("shortcut");
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.view.rows.length - 1, this.selectedIndex + 1);
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const selected = this.selectedRow();
      if (!selected) return;
      if (!selected.enterable || selected.status !== "running") {
        this.hint = "This session is not enterable right now.";
        this.refresh();
        return;
      }
      this.hint = undefined;
      this.onEnter?.(selected);
      return;
    }
    if (matchesKey(data, Key.left)) {
      const previous = this.returnStack.pop();
      if (previous) {
        this.view = previous.view;
        this.selectedIndex = previous.selectedIndex;
        this.refresh();
      } else {
        this.finish("back");
      }
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.finish("escape");
    }
  }

  selectedRow(): ManagerRow | undefined {
    return this.view.rows[this.selectedIndex];
  }

  currentView(): ManagerView {
    return this.view;
  }

  returnDepth(): number {
    return this.returnStack.length;
  }

  /** Close the manager from a host shortcut or lifecycle owner. */
  close(reason: "escape" | "shortcut" | "back" = "shortcut"): void {
    this.finish(reason);
  }

  /** Move to a child tree view while preserving the exact view to return to. */
  pushView(next: ManagerView): void {
    this.returnStack.push({ view: this.view, selectedIndex: this.selectedIndex });
    this.view = next;
    this.selectedIndex = 0;
    this.refresh();
  }

  /** Enter a live child view while preserving the exact prior tree view. */
  pushLiveView(next: { sessionId: string; rowId?: string; description: string; live: AgentLiveSession }): void {
    this.returnStack.push({ view: this.view, selectedIndex: this.selectedIndex });
    this.liveView = next;
    this.liveUnsubscribe = next.live.subscribe(() => this.refresh());
    this.invalidate();
    this.tui.requestRender();
  }

  /** Whether the manager is currently showing a live child. */
  inLiveView(): boolean {
    return this.liveView !== undefined;
  }

  private handleLiveInput(data: string): void {
    if (matchesKey(data, Key.ctrlShift("a"))) {
      this.finish("shortcut");
      return;
    }
    if (matchesKey(data, Key.left)) {
      const leavingLive = this.liveView;
      this.unsubscribeLive();
      this.liveView = undefined;
      const previous = this.returnStack.pop();
      if (previous) {
        let refreshed = this.refreshView?.(previous.view.scopeSessionId) ?? previous.view;
        // Settlement can race the registry's final write and pool cleanup. Use
        // the retained live snapshot as the immediate source of truth so a
        // just-settled child is never briefly re-enterable on return.
        if (leavingLive?.live.snapshot.settled && leavingLive.rowId) {
          const settledStatus = managerStatusForLiveStatus(leavingLive.live.snapshot.status);
          refreshed = {
            ...refreshed,
            rows: refreshed.rows.map((row) =>
              row.rowId === leavingLive.rowId
                ? { ...row, status: settledStatus, enterable: false }
                : row,
            ),
          };
        }
        this.view = refreshed;
        const previousRowId = previous.view.rows[previous.selectedIndex]?.rowId;
        const refreshedIndex = previousRowId
          ? refreshed.rows.findIndex((row) => row.rowId === previousRowId)
          : -1;
        this.selectedIndex = refreshedIndex >= 0
          ? refreshedIndex
          : Math.min(previous.selectedIndex, Math.max(0, refreshed.rows.length - 1));
      }
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.finish("escape");
      return;
    }
    const live = this.liveView!.live;
    if (live.snapshot.settled) return;
    if (matchesKey(data, Key.enter)) {
      const prompt = this.draftInput.trim();
      this.draftInput = "";
      if (!prompt) return;
      void live.steer(prompt).catch(() => {
        this.hint = "Steer failed. The child may have settled.";
        this.refresh();
      });
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.draftInput = this.draftInput.slice(0, -1);
      this.refresh();
      return;
    }
    if (data.length === 1 && data >= " ") {
      this.draftInput += data;
      this.refresh();
    }
  }

  /**
   * Release feed listeners when the host disposes the custom component.
   *
   * Disposal is intentionally independent from child control: closing or
   * resetting the modal must never abort or otherwise re-host the child.
   */
  dispose(): void {
    this.unsubscribeLive();
  }

  private unsubscribeLive(): void {
    this.liveUnsubscribe?.();
    this.liveUnsubscribe = undefined;
  }

  private finish(reason: "escape" | "shortcut" | "back"): void {
    if (this.settled) return;
    this.settled = true;
    this.unsubscribeLive();
    this.done(reason);
  }

  /** Show a transient hint line above the help row. */
  setHint(hint: string | undefined): void {
    this.hint = hint;
    this.refresh();
  }

  private refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  private statusIndicator(status: ManagerStatus): string {
    const icon = statusIcon(status);
    if (status === "completed") return this.theme.fg("success", icon);
    if (status === "failed") return this.theme.fg("error", icon);
    if (["cancelled", "interrupted", "stopped", "aborted"].includes(status)) {
      return this.theme.fg("warning", icon);
    }
    if (status === "active") return this.theme.fg("text", icon);
    return this.theme.fg("muted", icon);
  }

  private computeLastSiblingFlags(): boolean[] {
    const rows = this.view.rows;
    return rows.map((row, index) => {
      for (let next = index + 1; next < rows.length; next++) {
        if (rows[next]!.depth < row.depth) return true;
        if (rows[next]!.depth === row.depth) return false;
      }
      return true;
    });
  }

  private treePrefix(depth: number, isLast: readonly boolean[], ancestors: readonly number[], index: number): string {
    if (depth <= 0) return "";
    const chars: string[] = [];
    for (let level = 0; level < depth - 1; level++) {
      const ancestor = ancestors[level];
      chars.push(ancestor !== undefined && !isLast[ancestor] ? "│  " : "   ");
    }
    chars.push(isLast[index] ? "└─ " : "├─ ");
    return chars.join("");
  }
}

function managerStatusForLiveStatus(
  status: AgentLiveSession["snapshot"]["status"],
): ManagerStatus {
  return status === "running" ? "running" : status;
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) return `${remainingSeconds}s`;
  return `${minutes}m ${remainingSeconds}s`;
}

function overlayHeight(rows: number): number {
  return Math.max(1, Math.floor(Math.max(1, rows) * 0.8));
}

function statusColor(status: string): string {
  switch (status) {
    case "completed":
    case "done":
      return "success";
    case "failed":
    case "interrupted":
    case "cancelled":
    case "stopped":
    case "aborted":
      return "error";
    default:
      return "accent";
  }
}
