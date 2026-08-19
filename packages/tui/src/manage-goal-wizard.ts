import { Editor, Key, matchesKey, type Component, type TUI, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** The goal record exposed to the wizard, matching the runtime Goal shape. */
export interface ManageGoalItem {
  readonly goalId: string;
  readonly rootSessionId: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly intervalMs: number;
  readonly status: "active" | "paused";
  readonly pauseReason?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Outcome of a goal mutation performed by the controller. */
export type ManageGoalApplyResult =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly message: string };

/** UI-agnostic boundary implemented by the commands package. */
export interface ManageGoalController {
  /** The current goal for this root session, or undefined when none exists. */
  get(): Promise<ManageGoalItem | undefined>;
  /** Create or replace the goal. When a goal exists it is cleared first. */
  create(input: { prompt: string; interval: string; signal?: AbortSignal }): Promise<ManageGoalApplyResult>;
  /** Pause the current goal with an exact non-empty reason. */
  pause(reason: string, signal?: AbortSignal): Promise<ManageGoalApplyResult>;
  /** Resume the paused goal. */
  resume(signal?: AbortSignal): Promise<ManageGoalApplyResult>;
  /** Clear the current goal. */
  clear(signal?: AbortSignal): Promise<ManageGoalApplyResult>;
  cancel(): Promise<void>;
}

export type ManageGoalResult =
  | { readonly status: "saved"; readonly message: string }
  | { readonly status: "cancelled" }
  | { readonly status: "error"; readonly message: string };

export interface ManageGoalWizardOptions {
  tui: TUI;
  theme: { fg: (color: string, text: string) => string };
  controller: ManageGoalController;
  done: (result: ManageGoalResult) => void;
  signal?: AbortSignal;
}

type WizardStep =
  | { kind: "menu" }
  | { kind: "prompt" }
  | { kind: "interval" }
  | { kind: "reason" }
  | { kind: "confirm-clear" }
  | { kind: "busy"; message: string }
  | { kind: "result"; ok: boolean; message: string }
  | { kind: "error"; message: string };

/** Format an interval in milliseconds as a compact human duration such as 30s, 10m, 1h 30m, or 2d. */
export function formatGoalInterval(intervalMs: number): string {
  const units = [
    { label: "d", ms: 86_400_000 },
    { label: "h", ms: 3_600_000 },
    { label: "m", ms: 60_000 },
    { label: "s", ms: 1_000 },
  ] as const;
  const parts: string[] = [];
  let remainder = Math.max(0, intervalMs);
  for (const unit of units) {
    if (remainder >= unit.ms) {
      parts.push(`${Math.floor(remainder / unit.ms)}${unit.label}`);
      remainder %= unit.ms;
    }
  }
  return parts.length > 0 ? parts.join(" ") : `${intervalMs}ms`;
}

/**
 * Interactive goal management wizard for `/manage-goal`.
 *
 * The wizard owns only presentation and input state. The controller supplies
 * the goal record and mutations; `done` resolves with a status the command
 * maps to a host notification.
 */
export class ManageGoalWizard implements Component {
  private readonly tui: TUI;
  private readonly theme: NonNullable<ManageGoalWizardOptions["theme"]>;
  private readonly controller: ManageGoalController;
  private readonly done: (result: ManageGoalResult) => void;
  private readonly signal?: AbortSignal;
  private readonly editor: Editor;

  private step: WizardStep = { kind: "menu" };
  private menuIndex = 0;
  private goal: ManageGoalItem | undefined;
  private cachedLines: string[] | undefined;
  private settled = false;
  private busy = false;

  constructor(options: ManageGoalWizardOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.controller = options.controller;
    this.done = options.done;
    this.signal = options.signal;
    this.editor = new Editor(this.tui, {
      borderColor: (text: string) => this.theme.fg("accent", text),
      selectList: {
        selectedPrefix: (text: string) => text,
        selectedText: (text: string) => text,
        description: (text: string) => text,
        scrollInfo: (text: string) => text,
        noMatch: (text: string) => text,
      },
    });
    this.editor.onSubmit = () => {};
    if (options.signal) {
      options.signal.addEventListener("abort", this.cancel, { once: true });
      if (options.signal.aborted) void this.cancel();
    }
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.goal = await this.controller.get();
    } catch {
      this.goal = undefined;
    }
    this.menuIndex = 0;
    this.refresh();
  }

  private menuOptions(): string[] {
    if (!this.goal) return ["Create goal", "Done"];
    if (this.goal.status === "paused") {
      return ["Resume goal", "Replace goal", "Clear goal", "Done"];
    }
    return ["Pause goal", "Replace goal", "Clear goal", "Done"];
  }

  render(width: number): string[] {
    if (this.cachedLines) return this.cachedLines;
    const renderWidth = Math.max(1, Math.floor(width));
    const lines: string[] = [];
    const add = (prefix: string, text: string): void => {
      const prefixWidth = visibleWidth(prefix);
      const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
      const continuation = " ".repeat(prefixWidth);
      for (let i = 0; i < wrapped.length; i++) lines.push(`${i === 0 ? prefix : continuation}${wrapped[i]}`);
    };
    lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));
    switch (this.step.kind) {
      case "menu": {
        add(" ", this.theme.fg("accent", "Manage goal"));
        if (this.goal) {
          add(" ", this.theme.fg("text", `Status: ${this.goal.status}`));
          add(" ", this.theme.fg("text", `Prompt: ${this.goal.prompt}`));
          add(" ", this.theme.fg("muted", `Interval: ${formatGoalInterval(this.goal.intervalMs)}`));
          if (this.goal.pauseReason) add(" ", this.theme.fg("muted", `Pause reason: ${this.goal.pauseReason}`));
        } else {
          add(" ", this.theme.fg("muted", "No goal is set for this session."));
        }
        const options = this.menuOptions();
        for (let i = 0; i < options.length; i++) {
          const selected = i === this.menuIndex;
          add(selected ? this.theme.fg("accent", "> ") : "  ", this.theme.fg(selected ? "accent" : "text", `${i + 1}. ${options[i]}`));
        }
        add(" ", this.theme.fg("dim", "↑↓ navigate • Enter select • Esc cancel"));
        break;
      }
      case "prompt": {
        add(" ", this.theme.fg("accent", "Manage goal · goal prompt"));
        add(" ", this.theme.fg("muted", "The exact text delivered on each interval."));
        add(" ", this.theme.fg("text", this.promptText("Goal prompt:")));
        for (const line of this.editor.render(Math.max(1, renderWidth - 2))) add(" ", line);
        add(" ", this.theme.fg("dim", "Enter continue • Esc back"));
        break;
      }
      case "interval": {
        add(" ", this.theme.fg("accent", "Manage goal · interval"));
        add(" ", this.theme.fg("muted", "Positive duration such as 30s, 10m, 2h, or 1d. Empty uses the default 10m."));
        add(" ", this.theme.fg("text", this.promptText("Interval (optional):")));
        for (const line of this.editor.render(Math.max(1, renderWidth - 2))) add(" ", line);
        add(" ", this.theme.fg("dim", "Enter continue • Esc back"));
        break;
      }
      case "reason": {
        add(" ", this.theme.fg("accent", "Manage goal · pause reason"));
        add(" ", this.theme.fg("muted", "Exact non-empty reason the goal is blocked."));
        add(" ", this.theme.fg("text", this.promptText("Pause reason:")));
        for (const line of this.editor.render(Math.max(1, renderWidth - 2))) add(" ", line);
        add(" ", this.theme.fg("dim", "Enter continue • Esc back"));
        break;
      }
      case "confirm-clear": {
        add(" ", this.theme.fg("accent", "Manage goal · clear"));
        add(" ", this.theme.fg("text", "Clear the current goal? This removes it permanently."));
        const options = ["Clear", "Cancel"];
        for (let i = 0; i < options.length; i++) {
          const selected = i === this.menuIndex;
          add(selected ? this.theme.fg("accent", "> ") : "  ", this.theme.fg(selected ? "accent" : "text", `${i + 1}. ${options[i]}`));
        }
        add(" ", this.theme.fg("dim", "↑↓ navigate • Enter select • Esc back"));
        break;
      }
      case "busy":
        add(" ", this.theme.fg("muted", this.step.message));
        break;
      case "result":
        add(" ", this.theme.fg(this.step.ok ? "success" : "error", this.step.message));
        add(" ", this.theme.fg("dim", "Enter continue • Esc cancel"));
        break;
      case "error":
        add(" ", this.theme.fg("error", this.step.message));
        add(" ", this.theme.fg("dim", "Enter continue • Esc cancel"));
        break;
    }
    lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));
    this.cachedLines = lines;
    return lines;
  }

  private promptText(prompt: string): string {
    return this.step.kind === "prompt" || this.step.kind === "interval" || this.step.kind === "reason"
      ? `${prompt} ${this.editor.getExpandedText()}`.trim()
      : prompt;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.editor.invalidate();
  }

  handleInput(data: string): void {
    if (this.settled || this.busy) return;
    if (this.step.kind === "menu") {
      const options = this.menuOptions();
      if (matchesKey(data, Key.up)) {
        this.menuIndex = Math.max(0, this.menuIndex - 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.menuIndex = Math.min(options.length - 1, this.menuIndex + 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.escape)) {
        void this.cancel();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const option = options[this.menuIndex];
        if (!option) return;
        if (!this.goal) {
          if (option === "Create goal") this.startCreate();
          else this.finish({ status: "saved", message: "Done." });
        } else if (this.goal.status === "paused") {
          if (option === "Resume goal") void this.runResume();
          else if (option === "Replace goal") this.startCreate();
          else if (option === "Clear goal") this.startConfirmClear();
          else this.finish({ status: "saved", message: "Done." });
        } else {
          if (option === "Pause goal") this.startPause();
          else if (option === "Replace goal") this.startCreate();
          else if (option === "Clear goal") this.startConfirmClear();
          else this.finish({ status: "saved", message: "Done." });
        }
      }
      return;
    }
    if (this.step.kind === "confirm-clear") {
      if (matchesKey(data, Key.up)) {
        this.menuIndex = Math.max(0, this.menuIndex - 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.menuIndex = Math.min(1, this.menuIndex + 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.menuIndex = 0;
        this.step = { kind: "menu" };
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        if (this.menuIndex === 0) void this.runClear();
        else {
          this.menuIndex = 0;
          this.step = { kind: "menu" };
          this.refresh();
        }
      }
      return;
    }
    if (this.step.kind === "result" || this.step.kind === "error") {
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
        if (this.step.kind === "error") void this.cancel();
        else this.finish({ status: "saved", message: this.step.message });
      }
      return;
    }
    if (this.step.kind === "prompt") {
      if (matchesKey(data, Key.escape)) {
        this.step = { kind: "menu" };
        this.editor.setText("");
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.prompt = this.editor.getExpandedText();
        this.editor.setText("");
        this.step = { kind: "interval" };
        this.refresh();
        return;
      }
      this.editor.handleInput(data);
      this.refresh();
      return;
    }
    if (this.step.kind === "interval") {
      if (matchesKey(data, Key.escape)) {
        this.step = { kind: "prompt" };
        this.editor.setText(this.prompt);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.interval = this.editor.getExpandedText();
        this.editor.setText("");
        void this.submitCreate();
        return;
      }
      this.editor.handleInput(data);
      this.refresh();
      return;
    }
    if (this.step.kind === "reason") {
      if (matchesKey(data, Key.escape)) {
        this.step = { kind: "menu" };
        this.editor.setText("");
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.reason = this.editor.getExpandedText();
        this.editor.setText("");
        void this.submitPause();
        return;
      }
      this.editor.handleInput(data);
      this.refresh();
      return;
    }
  }

  private prompt = "";
  private interval = "";
  private reason = "";

  private startCreate(): void {
    this.prompt = "";
    this.interval = "";
    this.editor.setText("");
    this.step = { kind: "prompt" };
    this.refresh();
  }

  private startPause(): void {
    this.reason = "";
    this.editor.setText("");
    this.step = { kind: "reason" };
    this.refresh();
  }

  private startConfirmClear(): void {
    this.menuIndex = 0;
    this.step = { kind: "confirm-clear" };
    this.refresh();
  }

  private async submitCreate(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.step = { kind: "busy", message: "Saving goal…" };
    this.refresh();
    const result = await this.controller.create({ prompt: this.prompt, interval: this.interval, signal: this.signal });
    if (this.settled) return;
    this.busy = false;
    if (result.ok) await this.load();
    this.step = { kind: "result", ok: result.ok, message: result.message };
    this.refresh();
  }

  private async submitPause(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.step = { kind: "busy", message: "Pausing goal…" };
    this.refresh();
    const result = await this.controller.pause(this.reason, this.signal);
    if (this.settled) return;
    this.busy = false;
    if (result.ok) await this.load();
    this.step = { kind: "result", ok: result.ok, message: result.message };
    this.refresh();
  }

  private async runResume(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.step = { kind: "busy", message: "Resuming goal…" };
    this.refresh();
    const result = await this.controller.resume(this.signal);
    if (this.settled) return;
    this.busy = false;
    if (result.ok) await this.load();
    this.step = { kind: "result", ok: result.ok, message: result.message };
    this.refresh();
  }

  private async runClear(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.step = { kind: "busy", message: "Clearing goal…" };
    this.refresh();
    const result = await this.controller.clear(this.signal);
    if (this.settled) return;
    this.busy = false;
    if (result.ok) this.goal = undefined;
    this.step = { kind: "result", ok: result.ok, message: result.message };
    this.refresh();
  }

  private readonly cancel = async (): Promise<void> => {
    if (this.settled) return;
    this.settled = true;
    await this.controller.cancel();
    this.done({ status: "cancelled" });
  };

  private finish(result: ManageGoalResult): void {
    if (this.settled) return;
    this.settled = true;
    this.done(result);
  }

  private refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }
}
