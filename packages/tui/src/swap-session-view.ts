import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { statusColor, statusIcon } from "./agent-manager-chrome.ts";

export type SwapViewReason = "escape" | "back" | "alt-left";

export interface SwapSessionViewTheme {
  fg: (color: string, text: string) => string;
}

export interface SwapLiveSession {
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

export interface SwapSessionViewOptions {
  tui: TUI;
  theme: SwapSessionViewTheme;
  live: SwapLiveSession;
  done: (reason: SwapViewReason) => void;
  abort?: () => Promise<void>;
  confirm?: (title: string, message: string) => Promise<boolean>;
}

/**
 * Full-window session swap view.
 *
 * Unlike AgentLiveManager's bordered 80% panel, this view fills the main
 * window area (rendered as a full-region overlay) and shows the child's
 * transcript with a steer composer. It stays quiet for the background parent
 * and only the footer indicates the swapped state.
 */
export class SwapSessionView implements Component {
  private readonly tui: TUI;
  private readonly theme: SwapSessionViewTheme;
  private readonly live: SwapLiveSession;
  private readonly done: SwapSessionViewOptions["done"];
  private readonly abort?: SwapSessionViewOptions["abort"];
  private readonly confirm: NonNullable<SwapSessionViewOptions["confirm"]>;
  private readonly unsubscribe: () => void;
  private readonly onFeedUpdate = (): void => { this.refresh(); };
  private hint: string | undefined;
  private cachedLines: string[] | undefined;
  private cachedWidth = -1;
  private cachedHeight = -1;
  private settled = false;
  private disposed = false;
  private draftInput = "";
  private cancelPending = false;
  private scroll = 0;

  private availableHeight(): number {
    const rows = Math.max(1, this.tui.terminal?.rows ?? 24);
    // Reserve 2 lines for footer hint area? The host footer is separate,
    // so use almost full height; leave 1 line for legend.
    return Math.max(10, rows - 2);
  }

  constructor(options: SwapSessionViewOptions) {
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
    const height = this.availableHeight();
    if (this.cachedLines && this.cachedWidth === renderWidth && this.cachedHeight === height) {
      return this.cachedLines;
    }
    this.cachedWidth = renderWidth;
    this.cachedHeight = height;
    const snapshot = this.live.snapshot;
    const contentWidth = Math.max(1, renderWidth - 2);
    const transcriptLines = this.transcriptLines(snapshot, contentWidth);
    const reserved = 1 + (this.hint ? 1 : 0) + (!snapshot.settled && this.draftInput ? 1 : 0);
    const visibleBody = Math.max(1, height - 2 - reserved);
    const totalBody = transcriptLines.length + (this.hint ? 1 : 0) + (!snapshot.settled && this.draftInput ? 1 : 0);
    const maxScroll = Math.max(0, totalBody - visibleBody);
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    const start = Math.max(0, totalBody - visibleBody - this.scroll);
    const end = Math.max(0, totalBody - this.scroll);
    const body: string[] = [];
    // No bordered panel: render transcript directly covering main window
    body.push(...transcriptLines.slice(start, end));
    if (this.hint) body.push(this.theme.fg("warning", this.hint));
    if (!snapshot.settled && this.draftInput) {
      body.push(this.theme.fg("accent", `steer> ${this.draftInput}█`));
    }
    while (body.length < visibleBody) body.push("");
    const legend = this.legend(snapshot);
    // Footer legend inside main window; host footer outside shows swapped hint too
    body.push(this.theme.fg("dim", legend));
    // Pad to height
    while (body.length < height) body.push("");
    const lines = body.slice(0, height).map((l) => truncateToWidth(l, renderWidth));
    this.cachedLines = lines;
    return lines;
  }

  private transcriptLines(
    snapshot: SwapLiveSession["snapshot"],
    _contentWidth: number,
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
      lines.push(this.theme.fg("dim", entry.role === "user" ? `› ${entry.text || "user activity"}` : `· ${entry.text || "assistant activity"}`));
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
    // Alt+Left also returns (stack pop)
    if (matchesKey(data, Key.alt(Key.left))) {
      this.finish(data, "alt-left");
      return;
    }
    if (this.handleScroll(data)) return;
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

  private legend(snapshot: SwapLiveSession["snapshot"]): string {
    const scrollHint = this.scroll > 0 ? "  ↑ scroll • Home tail • PageDown next" : "";
    if (snapshot.settled) {
      return `read-only • ← back • Esc close${scrollHint}`;
    }
    if (this.hint) {
      return `${this.hint} • Esc close${scrollHint}`;
    }
    return `Type to steer • Enter send • Alt+x cancel • ← back • Esc close${scrollHint}`;
  }

  private handleScroll(data: string): boolean {
    const snapshot = this.live.snapshot;
    const height = this.availableHeight();
    const renderWidth = this.cachedWidth > 0 ? this.cachedWidth : Math.max(1, Math.floor(this.tui.terminal?.columns ?? 100));
    const contentWidth = Math.max(1, renderWidth - 2);
    const transcriptLines = this.transcriptLines(snapshot, contentWidth);
    const reserved = 1 + (this.hint ? 1 : 0) + (!snapshot.settled && this.draftInput ? 1 : 0);
    const visibleBody = Math.max(1, height - 2 - reserved);
    const totalBody = transcriptLines.length + (this.hint ? 1 : 0) + (!snapshot.settled && this.draftInput ? 1 : 0);
    const maxScroll = Math.max(0, totalBody - visibleBody);
    if (matchesKey(data, Key.pageUp)) {
      this.scroll = Math.min(maxScroll, this.scroll + visibleBody);
      this.refresh();
      return true;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scroll = Math.max(0, this.scroll - visibleBody);
      this.refresh();
      return true;
    }
    if (matchesKey(data, Key.end)) {
      this.scroll = maxScroll;
      this.refresh();
      return true;
    }
    if (matchesKey(data, Key.home)) {
      this.scroll = 0;
      this.refresh();
      return true;
    }
    if (matchesKey(data, Key.up) && maxScroll > 0) {
      this.scroll = Math.min(maxScroll, this.scroll + 1);
      this.refresh();
      return true;
    }
    if (matchesKey(data, Key.down) && maxScroll > 0) {
      this.scroll = Math.max(0, this.scroll - 1);
      this.refresh();
      return true;
    }
    return false;
  }

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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
  }

  private finish(data: string, reasonOverride?: SwapViewReason): void {
    if (this.settled) return;
    this.settled = true;
    this.dispose();
    if (reasonOverride) {
      this.done(reasonOverride);
      return;
    }
    this.done(matchesKey(data, Key.escape) ? "escape" : "back");
  }

  private refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }
}
