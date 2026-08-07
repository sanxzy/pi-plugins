import {
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";

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
  private readonly returnStack: ManagerView[] = [];
  private view: ManagerView;
  private selectedIndex = 0;
  private cachedLines: string[] | undefined;
  private cachedWidth = -1;
  private hint: string | undefined;
  private settled = false;

  constructor(options: AgentManagerOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.done = options.done;
    this.onEnter = options.onEnter;
    this.view = options.view;
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, Math.floor(width));
    // The cache is width-keyed so a terminal resize always re-wraps rows.
    if (this.cachedLines && this.cachedWidth === renderWidth) return this.cachedLines;
    this.cachedWidth = renderWidth;
    const lines: string[] = [];
    lines.push(this.theme.fg("accent", truncateToWidth("Agent Manager", renderWidth)));
    lines.push(this.theme.fg("muted", truncateToWidth(`Session ${this.view.scopeSessionId}`, renderWidth)));

    if (this.view.rows.length === 0) {
      lines.push(this.theme.fg("muted", truncateToWidth("No child sessions", renderWidth)));
    } else {
      const isLast = this.computeLastSiblingFlags();
      const ancestorStack: number[] = [];
      for (let index = 0; index < this.view.rows.length; index++) {
        const row = this.view.rows[index]!;
        while (ancestorStack.length > row.depth) ancestorStack.pop();
        const prefix = this.treePrefix(row.depth, isLast, ancestorStack, index);
        const cursor = index === this.selectedIndex ? this.theme.fg("accent", "› ") : "  ";
        const indicator = this.statusIndicator(row.status);
        const duration = formatDuration(row.durationMs);
        const body = `${prefix}${indicator} ${row.description} (${duration})`;
        const available = Math.max(1, renderWidth - visibleWidth(cursor));
        lines.push(cursor + truncateToWidth(body, available));
        ancestorStack.push(index);
      }
    }

    if (this.view.rows.length > 0) {
      lines.push(
        this.theme.fg("muted", truncateToWidth(`(${this.selectedIndex + 1}/${this.view.rows.length})`, renderWidth)),
      );
    }
    if (this.hint) {
      lines.push(this.theme.fg("warning", truncateToWidth(this.hint, renderWidth)));
    }
    lines.push(
      this.theme.fg(
        "dim",
        truncateToWidth("Ctrl+↑/↓ move • Enter view • Ctrl+← back • Esc close", renderWidth),
      ),
    );
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = -1;
  }

  handleInput(data: string): void {
    if (this.settled) return;

    if (matchesKey(data, Key.ctrlShift("a"))) {
      this.finish("shortcut");
      return;
    }
    if (matchesKey(data, Key.ctrl("up"))) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.ctrl("down"))) {
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
    if (matchesKey(data, Key.ctrl("left"))) {
      if (this.returnStack.length === 0) {
        this.finish("back");
      } else {
        this.view = this.returnStack.pop()!;
        this.selectedIndex = 0;
        this.refresh();
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

  /** Move to a child view while preserving the exact view to return to. */
  pushView(next: ManagerView): void {
    this.returnStack.push(this.view);
    this.view = next;
    this.selectedIndex = 0;
    this.refresh();
  }

  private finish(reason: "escape" | "shortcut" | "back"): void {
    if (this.settled) return;
    this.settled = true;
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
    switch (status) {
      case "active":
        return this.theme.fg("text", "●");
      case "completed":
        return this.theme.fg("success", "●");
      case "failed":
        return this.theme.fg("error", "●");
      case "cancelled":
      case "interrupted":
      case "stopped":
      case "aborted":
        return this.theme.fg("warning", "●");
      case "created":
      case "queued":
      case "running":
        return this.theme.fg("muted", "◯");
    }
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

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) return `${remainingSeconds}s`;
  return `${minutes}m ${remainingSeconds}s`;
}
