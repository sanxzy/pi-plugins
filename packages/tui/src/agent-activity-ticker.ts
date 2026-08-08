import { sliceByColumn, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

/** Theme surface the ticker needs from the host Theme. */
export interface AgentActivityTickerTheme {
  fg: (color: string, text: string) => string;
}

/**
 * One-line activity feed for a running agent.
 *
 * Each item is a single plain-text line, e.g. `⌘ bash` or `· implementing`,
 * produced by the host from the live child's latest transcript entry.
 */
export interface AgentActivityItem {
  readonly jobId: string;
  readonly text: string;
}

/** Minimal live-activity surface the ticker observes (host-bridged to the pool). */
export interface AgentActivitySource {
  getItems(): readonly AgentActivityItem[];
  subscribe(listener: () => void): () => void;
}

/** Injectable clock so tests drive the marquee without real timers. */
export interface TickerDriver {
  start(fn: () => void): () => void;
}

export interface AgentActivityTickerOptions {
  tui: TUI;
  theme: AgentActivityTickerTheme;
  source: AgentActivitySource;
  /** Marquee clock; defaults to `setInterval` at `tickMs`. */
  ticker?: TickerDriver;
  /** Milliseconds between marquee ticks; defaults to 120. */
  tickMs?: number;
}

/** Separator between agent items, padded so a window edge never touches text. */
const ITEM_SEPARATOR = "  ✦  ";

/**
 * Compact single-line news ticker above the composer.
 *
 * Renders the latest activity of every running agent as one continuously
 * scrolling line (right to left). Renders no lines when no agents run, so the
 * composer stays untouched. The marquee advances on a timer and requests
 * re-renders; `dispose()` releases the timer and the source subscription.
 */
export class AgentActivityTicker implements Component {
  private readonly tui: TUI;
  private readonly theme: AgentActivityTickerTheme;
  private readonly source: AgentActivitySource;
  private readonly tickMs: number;
  private readonly stop: () => void;
  private readonly unsubscribe: () => void;
  /** Current marquee column offset (0 = window starts at the line's start). */
  private offset = 0;
  /** Text of the full combined ticker line; rebuild on change. */
  private line = "";
  private disposed = false;

  constructor(options: AgentActivityTickerOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.source = options.source;
    this.tickMs = options.tickMs ?? 120;
    this.unsubscribe = this.source.subscribe(() => this.refresh());
    const start = options.ticker?.start ?? ((fn: () => void): (() => void) => {
      const timer = setInterval(fn, this.tickMs);
      return () => clearInterval(timer);
    });
    this.stop = start(() => this.tick());
    this.refresh();
  }

  /** Re-read the activity feed and restart the marquee from the beginning. */
  invalidate(): void {
    this.refresh();
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, Math.floor(width));
    if (this.line.length === 0) return [];
    return [this.theme.fg("dim", this.window(this.line, this.offset, renderWidth))];
  }

  /** Release the timer and subscription; safe to call more than once. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.unsubscribe();
  }

  private refresh(): void {
    this.offset = 0;
    this.line = this.source
      .getItems()
      .map((item) => item.text)
      .join(ITEM_SEPARATOR);
  }

  private tick(): void {
    if (this.disposed || this.line.length === 0) return;
    this.offset = (this.offset + 1) % Math.max(1, visibleWidth(this.line));
    this.tui.requestRender();
  }

  /**
   * Window `width` columns of the marquee line at `offset`, looping so the
   * window never runs out of content. The line is duplicated so a window that
   * crosses the end still has content; `sliceByColumn` preserves ANSI codes.
   */
  private window(line: string, offset: number, width: number): string {
    const total = visibleWidth(line);
    if (total <= width) return line;
    return sliceByColumn(line + line, offset, width);
  }
}
