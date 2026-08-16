import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import { renderBorderedPanel, statusColor, statusIcon } from "./agent-manager-chrome.ts";

/** How a live child view was left, for the manager's return-stack bookkeeping. */
export type LiveViewReason = "escape" | "shortcut" | "back";

export interface AgentLiveManagerOptions {
  tui: TUI;
  theme: AgentLiveManagerTheme;
  live: AgentLiveSession;
  done: (reason: LiveViewReason) => void;
  /**
   * Cancel the child through the runtime abort path after the user confirms.
   * Supplied by the host so no runtime control reaches the TUI package.
   */
  abort?: () => Promise<void>;
  /** Ask the user to confirm a destructive action. Defaults to a declined answer. */
  confirm?: (title: string, message: string) => Promise<boolean>;
}

/** Theme surface the live view needs from the host Theme. */
export interface AgentLiveManagerTheme {
  fg: (color: string, text: string) => string;
}

/** The live child control surface the view renders and steers. */
export interface AgentLiveSession {
  /** Row identity used to update the parent tree after settlement. */
  readonly rowId?: string;
  snapshot: {
    status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
    settled: boolean;
    transcript: readonly {
      readonly id: string;
      readonly kind: "message" | "tool";
      readonly role?: "user" | "assistant";
      readonly text: string;
      readonly complete: boolean;
      readonly toolCallId?: string;
      readonly toolName?: string;
      readonly args?: unknown;
      readonly isError?: boolean;
    }[];
  };
  subscribe(listener: () => void): () => void;
  steer(prompt: string): Promise<void>;
}

/**
 * Focused live view over one running child.
 *
 * The component owns presentation and input state; the host owns the live
 * control, so no PI session handle reaches the TUI package. Input routes only
 * through `steer`, never to the parent, and once the snapshot settles no
 * further input is accepted.
 */
export class AgentLiveManager implements Component {
  private readonly tui: TUI;
  private readonly theme: AgentLiveManagerTheme;
  private readonly live: AgentLiveSession;
  private readonly done: AgentLiveManagerOptions["done"];
  private readonly abort?: AgentLiveManagerOptions["abort"];
  private readonly confirm: NonNullable<AgentLiveManagerOptions["confirm"]>;
  private readonly unsubscribe: () => void;
  private readonly onFeedUpdate = (): void => {
    this.refresh();
  };
  private hint: string | undefined;
  private cachedLines: string[] | undefined;
  private cachedWidth = -1;
  private cachedHeight = -1;
  private settled = false;
  private disposed = false;
  private draftInput = "";
  private cancelPending = false;
  /** 0 = transcript tail (auto-follow); positive values reveal earlier lines. */
  private liveScroll = 0;

  /**
   * The overlay panel is a stable ~80% of the terminal height. The host mounts
   * it without a maxHeight (see footer.ts), so this panel height is the only
   * bound; sizing to the full terminal would let the newest activity slip
   * below the host's slice.
   */
  private panelHeight(): number {
    const rows = Math.max(1, this.tui.terminal?.rows ?? 24);
    return Math.max(10, Math.floor(rows * 0.8));
  }

  constructor(options: AgentLiveManagerOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.live = options.live;
    this.done = options.done;
    this.abort = options.abort;
    this.confirm = options.confirm ?? (async () => false);
    this.unsubscribe = options.live.subscribe(this.onFeedUpdate);
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, Math.floor(width));
    const panelHeight = this.panelHeight();
    if (this.cachedLines && this.cachedWidth === renderWidth && this.cachedHeight === panelHeight) {
      return this.cachedLines;
    }
    this.cachedWidth = renderWidth;
    this.cachedHeight = panelHeight;
    const snapshot = this.live.snapshot;
    const contentWidth = Math.max(1, renderWidth - 4);
    const transcriptLines = this.liveTranscriptLines(snapshot, contentWidth);
    const reserved = 1 + (this.hint ? 1 : 0) + (!snapshot.settled && this.draftInput ? 1 : 0);
    const visibleBody = Math.max(1, panelHeight - 6 - reserved);
    const totalBody = transcriptLines.length + (this.hint ? 1 : 0) + (!snapshot.settled && this.draftInput ? 1 : 0);
    const maxScroll = Math.max(0, totalBody - visibleBody);
    this.liveScroll = Math.max(0, Math.min(this.liveScroll, maxScroll));

    const start = Math.max(0, totalBody - visibleBody - this.liveScroll);
    const end = Math.max(0, totalBody - this.liveScroll);
    const body: string[] = [this.theme.fg("dim", "Transcript")];
    body.push(...transcriptLines.slice(start, end));
    if (this.hint) body.push(this.theme.fg("warning", this.hint));
    if (!snapshot.settled && this.draftInput) {
      body.push(this.theme.fg("accent", `steer> ${this.draftInput}█`));
    }
    const bodyRows = Math.max(0, panelHeight - 6);
    while (body.length < bodyRows) body.push("");
    const legend = this.legend(snapshot);
    const statusColorName = statusColor(snapshot.status);
    const status = `${this.theme.fg(statusColorName, `${statusIcon(snapshot.status)} ${snapshot.status}`)}  •  ${snapshot.transcript.length} events`;
    const lines = renderBorderedPanel(this.theme, {
      width: renderWidth,
      title: `${this.theme.fg("accent", "Child Session")} ─ ${this.theme.fg("dim", snapshot.status)}`,
      status,
      body,
      footer: legend,
    });
    this.cachedLines = lines.slice(0, panelHeight);
    return this.cachedLines;
  }

  private liveTranscriptLines(
    snapshot: AgentLiveSession["snapshot"],
    contentWidth: number,
  ): string[] {
    if (snapshot.transcript.length === 0) {
      return [
        this.theme.fg(
          "muted",
          snapshot.settled
            ? "No transcript recorded — this child finished without activity."
            : "No activity yet — waiting for the child to start. Type a prompt to steer it.",
        ),
      ];
    }
    const lines: string[] = [];
    for (const entry of snapshot.transcript) {
      if (entry.kind === "tool") {
        const name = entry.toolName ?? "tool";
        lines.push(this.theme.fg(entry.isError ? "warning" : "muted", `⌘ ${name}${entry.complete ? "" : " (running)"}${entry.isError ? " (failed)" : ""}`));
        continue;
      }
      lines.push(this.theme.fg("dim", entry.role === "user" ? "› user activity" : "· assistant activity"));
    }
    return lines;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = -1;
    this.cachedHeight = -1;
  }

  handleInput(data: string): void {
    if (this.settled) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
      this.finish(data);
      return;
    }
    if (this.handleLiveScroll(data)) return;
    if (this.live.snapshot.settled) return;
    if (matchesKey(data, Key.alt("x"))) {
      this.requestCancel();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const prompt = this.draftInput.trim();
      this.draftInput = "";
      if (!prompt) return;
      this.hint = undefined;
      void this.live.steer(prompt).then(
        () => {
          if (this.disposed || this.settled || this.live.snapshot.settled) return;
          this.refresh();
        },
        () => {
          if (this.disposed || this.settled || this.live.snapshot.settled) return;
          this.hint = "Steer failed. The child may have settled.";
          this.refresh();
        },
      );
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

  private legend(snapshot: AgentLiveSession["snapshot"]): string {
    const scrollHint = this.liveScroll > 0 ? "  ↑ scroll • Home tail • PageDown next" : "";
    if (snapshot.settled) {
      return this.theme.fg("dim", `read-only • ← back • Esc close${scrollHint}`);
    }
    if (this.hint) {
      return this.theme.fg("warning", `${this.hint} • Esc close${scrollHint}`);
    }
    return this.theme.fg("dim", `Type to steer • Enter send • Alt+x cancel • ← back • Esc close${scrollHint}`);
  }

  /**
   * Handle transcript scrolling without allowing navigation bytes into the
   * steering draft. Offset zero is the newest tail; positive offsets reveal
   * earlier logical transcript rows.
   */
  private handleLiveScroll(data: string): boolean {
    const snapshot = this.live.snapshot;
    const panelHeight = this.panelHeight();
    // Input normally follows a render, so use the overlay's last rendered
    // width rather than the full terminal width. The fallback keeps key input
    // deterministic before the first render.
    const renderWidth = this.cachedWidth > 0
      ? this.cachedWidth
      : Math.max(1, Math.floor(this.tui.terminal?.columns ?? 100));
    const contentWidth = Math.max(1, renderWidth - 4);
    const transcriptLines = this.liveTranscriptLines(snapshot, contentWidth);
    const reserved = 1 + (this.hint ? 1 : 0) + (!snapshot.settled && this.draftInput ? 1 : 0);
    const visibleBody = Math.max(1, panelHeight - 6 - reserved);
    const totalBody = transcriptLines.length + (this.hint ? 1 : 0) + (!snapshot.settled && this.draftInput ? 1 : 0);
    const maxScroll = Math.max(0, totalBody - visibleBody);
    if (matchesKey(data, Key.pageUp)) {
      this.liveScroll = Math.min(maxScroll, this.liveScroll + visibleBody);
      this.refresh();
      return true;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.liveScroll = Math.max(0, this.liveScroll - visibleBody);
      this.refresh();
      return true;
    }
    if (matchesKey(data, Key.end)) {
      this.liveScroll = maxScroll;
      this.refresh();
      return true;
    }
    if (matchesKey(data, Key.home)) {
      this.liveScroll = 0;
      this.refresh();
      return true;
    }
    if (matchesKey(data, Key.up) && maxScroll > 0) {
      this.liveScroll = Math.min(maxScroll, this.liveScroll + 1);
      this.refresh();
      return true;
    }
    if (matchesKey(data, Key.down) && maxScroll > 0) {
      this.liveScroll = Math.max(0, this.liveScroll - 1);
      this.refresh();
      return true;
    }
    return false;
  }

  /**
   * Ask for confirmation, then abort the child through the host-supplied
   * runtime path. Dismissing or declining never aborts.
   */
  private requestCancel(): void {
    if (this.cancelPending) return;
    this.cancelPending = true;
    void this.confirm("Cancel child", "Abort this child agent? Its work is discarded.").then((accepted) => {
      this.cancelPending = false;
      if (!accepted || !this.abort) return;
      this.hint = "Cancelling child…";
      this.refresh();
      void this.abort().then(
        () => {
          if (this.disposed || this.settled) return;
          this.hint = "Cancelled.";
          this.refresh();
        },
        () => {
          if (this.disposed || this.settled) return;
          this.hint = "Cancel failed. The child may have settled.";
          this.refresh();
        },
      );
    });
  }

  /** Release the subscription; safe to call more than once. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
  }

  private finish(data: string): void {
    if (this.settled) return;
    this.settled = true;
    this.dispose();
    this.done(matchesKey(data, Key.escape) ? "escape" : "back");
  }

  private refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }
}

/** Tool arguments are intentionally omitted from the focused live view. */
