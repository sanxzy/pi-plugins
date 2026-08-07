import type { Component, TUI } from "@earendil-works/pi-tui";

/** How a live child view was left, for the manager's return-stack bookkeeping. */
export type LiveViewReason = "escape" | "shortcut" | "back";

export interface AgentLiveManagerOptions {
  tui: TUI;
  theme: AgentLiveManagerTheme;
  live: AgentLiveSession;
  done: (reason: LiveViewReason) => void;
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
  private readonly unsubscribe: () => void;
  private readonly onFeedUpdate = (): void => {
    this.refresh();
  };
  private hint: string | undefined;
  private cachedLines: string[] | undefined;
  private cachedWidth = -1;
  private settled = false;

  constructor(options: AgentLiveManagerOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.live = options.live;
    this.done = options.done;
    this.unsubscribe = options.live.subscribe(this.onFeedUpdate);
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, Math.floor(width));
    if (this.cachedLines && this.cachedWidth === renderWidth) return this.cachedLines;
    this.cachedWidth = renderWidth;
    const snapshot = this.live.snapshot;
    const lines: string[] = [];
    lines.push(this.theme.fg("accent", `Child Session ${snapshot.status}`));

    if (snapshot.transcript.length === 0) {
      lines.push(this.theme.fg("muted", "No activity yet."));
    } else {
      for (const entry of snapshot.transcript) {
        if (entry.kind === "tool") {
          const name = entry.toolName ?? "tool";
          lines.push(this.theme.fg("muted", `  ⌘ ${name} ${entry.complete ? "" : "(running)"}`));
          continue;
        }
        if (entry.role === "user") {
          lines.push(this.theme.fg("text", `  you: ${entry.text}`));
        } else {
          lines.push(this.theme.fg("text", `  ${entry.text}`));
        }
      }
    }

    if (this.hint) {
      lines.push(this.theme.fg("warning", this.hint));
    }
    const help = snapshot.settled
      ? "Ctrl+← back • Esc close"
      : "Type to steer this child • Ctrl+← back • Esc close";
    lines.push(this.theme.fg("dim", help));
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = -1;
  }

  handleInput(data: string): void {
    if (this.settled) return;
    if (matchesEscape(data) || matchesCtrlLeft(data)) {
      this.finish(data);
      return;
    }
    if (this.live.snapshot.settled) return;
    const prompt = data.trim();
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
  }

  /** Release the subscription; safe to call more than once. */
  dispose(): void {
    this.unsubscribe();
  }

  private finish(data: string): void {
    this.settled = true;
    this.dispose();
    this.done(matchesEscape(data) ? "escape" : "back");
  }

  private refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }
}

function matchesEscape(data: string): boolean {
  return data === "";
}

function matchesCtrlLeft(data: string): boolean {
  return data === "[1;5D";
}
