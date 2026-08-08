import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import { fitPanelToHeight, renderBorderedPanel, statusIcon } from "./agent-manager-chrome.ts";

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
    const viewportRows = Math.max(1, this.tui.terminal?.rows ?? 24);
    if (this.cachedLines && this.cachedWidth === renderWidth && this.cachedHeight === viewportRows) {
      return this.cachedLines;
    }
    this.cachedWidth = renderWidth;
    this.cachedHeight = viewportRows;
    const snapshot = this.live.snapshot;
    const contentWidth = Math.max(1, renderWidth - 4);
    const transcriptLines = this.liveTranscriptLines(snapshot, contentWidth);
    const reserved = 1 + (this.hint ? 1 : 0) + (!snapshot.settled && this.draftInput ? 1 : 0);
    const visibleBody = Math.max(1, viewportRows - 6 - reserved);
    const totalBody = transcriptLines.length + (this.hint ? 1 : 0) + (!snapshot.settled && this.draftInput ? 1 : 0);
    const maxScroll = Math.max(0, totalBody - visibleBody);
    this.liveScroll = Math.max(0, Math.min(this.liveScroll, maxScroll));

    const start = Math.max(0, totalBody - visibleBody - this.liveScroll);
    const end = Math.max(0, totalBody - this.liveScroll);
    const body: string[] = [this.theme.fg("dim", "Transcript")];
    body.push(...transcriptLines.slice(start, end));
    if (this.hint) body.push(this.theme.fg("warning", this.hint));
    if (!snapshot.settled && this.draftInput) {
      body.push(this.theme.fg("accent", `steer> ${this.draftInput}`));
    }
    const scrollHint = this.liveScroll > 0 ? "  ↑ scroll" : "";
    const footer = snapshot.settled
      ? this.theme.fg("dim", `${statusIcon(snapshot.status)} ${snapshot.status} • read-only • ← back • Esc close${scrollHint}`)
      : this.theme.fg("dim", `Type to steer this child • Enter send • Alt+x cancel • ← back • Esc close${scrollHint}`);
    const status = `${statusIcon(snapshot.status)} ${snapshot.status}  •  ${snapshot.transcript.length} events`;
    const lines = renderBorderedPanel(this.theme, {
      width: renderWidth,
      title: `${this.theme.fg("accent", "Child Session")} ─ ${this.theme.fg("dim", snapshot.status)}`,
      status,
      body,
      footer,
    });
    this.cachedLines = fitPanelToHeight(lines, viewportRows);
    return this.cachedLines;
  }

  private liveTranscriptLines(
    snapshot: AgentLiveSession["snapshot"],
    contentWidth: number,
  ): string[] {
    if (snapshot.transcript.length === 0) return [this.theme.fg("muted", "No activity yet.")];
    const lines: string[] = [];
    for (const entry of snapshot.transcript) {
      if (entry.kind === "tool") {
        const name = entry.toolName ?? "tool";
        lines.push(this.theme.fg("muted", `⌘ ${name}${entry.complete ? "" : " (running)"}`));
        for (const argLine of renderToolArgs(entry.args, contentWidth)) {
          lines.push(this.theme.fg("dim", argLine));
        }
        continue;
      }
      const prefix = entry.role === "user" ? "› you: " : "· ";
      const wrapped = wrapTextWithAnsi(`${prefix}${entry.text}`, contentWidth);
      for (let index = 0; index < wrapped.length; index++) {
        const line = index === 0 ? wrapped[index]! : `      ${wrapped[index]!}`;
        lines.push(this.theme.fg("text", truncateToWidth(line, contentWidth)));
      }
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
          this.refresh();
        },
        () => {
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

  /**
   * Handle transcript scrolling without allowing navigation bytes into the
   * steering draft. Offset zero is the newest tail; positive offsets reveal
   * earlier logical transcript rows.
   */
  private handleLiveScroll(data: string): boolean {
    const snapshot = this.live.snapshot;
    const viewportRows = Math.max(1, this.tui.terminal?.rows ?? 24);
    // Input normally follows a render, so use the overlay's last rendered
    // width rather than the full terminal width. The fallback keeps key input
    // deterministic before the first render.
    const renderWidth = this.cachedWidth > 0
      ? this.cachedWidth
      : Math.max(1, Math.floor(this.tui.terminal?.columns ?? 100));
    const contentWidth = Math.max(1, renderWidth - 4);
    const transcriptLines = this.liveTranscriptLines(snapshot, contentWidth);
    const reserved = 1 + (this.hint ? 1 : 0) + (!snapshot.settled && this.draftInput ? 1 : 0);
    const visibleBody = Math.max(1, viewportRows - 6 - reserved);
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
          this.hint = "Cancelled.";
          this.refresh();
        },
        () => {
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

/** Render a tool call's arguments as compact `key: value` lines. */
function renderToolArgs(args: unknown, width: number): string[] {
  if (args === undefined || args === null) return [];
  const entries =
    typeof args === "object" && !Array.isArray(args)
      ? Object.entries(args as Record<string, unknown>)
      : [["value", args]];
  if (entries.length === 0) return [];
  const lines: string[] = [];
  for (const [key, value] of entries) {
    const line = `  ${key}: ${formatArgValue(value)}`;
    lines.push(...wrapTextWithAnsi(line, width));
  }
  return lines;
}

function formatArgValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value === "" ? '""' : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
