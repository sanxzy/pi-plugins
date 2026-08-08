import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { fitPanelToHeight, renderBorderedPanel, statusIcon } from "./agent-manager-chrome.ts";

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
    const viewportRows = Math.max(1, this.tui.terminal?.rows ?? 24);
    const contentWidth = Math.max(1, Math.floor(width) - 4);
    const body: string[] = [this.theme.fg("dim", "Transcript")];

    if (snapshot.transcript.length === 0) {
      body.push(this.theme.fg("muted", "No activity yet."));
    } else {
      const budget = Math.max(1, viewportRows - 8 - (this.hint ? 1 : 0));
      for (const entry of snapshot.transcript.slice(-budget)) {
        if (entry.kind === "tool") {
          const name = entry.toolName ?? "tool";
          body.push(this.theme.fg("muted", `⌘ ${name}${entry.complete ? "" : " (running)"}`));
          for (const argLine of renderToolArgs(entry.args, contentWidth)) {
            body.push(this.theme.fg("dim", argLine));
          }
          continue;
        }
        const prefix = entry.role === "user" ? "› you: " : "· ";
        body.push(this.theme.fg("text", truncateToWidth(`${prefix}${entry.text}`, contentWidth)));
      }
    }

    if (this.hint) body.push(this.theme.fg("warning", this.hint));
    const footer = snapshot.settled
      ? this.theme.fg("dim", `${statusIcon(snapshot.status)} ${snapshot.status} • read-only • ← back • Esc close`)
      : this.theme.fg("dim", "Type to steer this child • Enter send • ← back • Esc close");
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

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = -1;
  }

  handleInput(data: string): void {
    if (this.settled) return;
    if (matchesEscape(data) || matchesLeft(data)) {
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

function matchesLeft(data: string): boolean {
  return data === "[D";
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
