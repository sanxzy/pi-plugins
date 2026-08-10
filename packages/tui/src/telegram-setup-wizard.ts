import {
  Editor,
  Key,
  matchesKey,
  type Component,
  type TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

/** A pending pairing request shown to the operator for numeric-ID approval. */
export interface TelegramPendingPairing {
  id: number;
  userId: string;
  code: string;
  createdAt: string;
  expiresAt: string;
}

/** UI-agnostic setup boundary structurally implemented by channels. */
export interface TelegramSetupController {
  getInitialToken(): string;
  submitToken(token: string): Promise<{ ok: true; message?: string } | { ok: false; message: string }>;
  listPendingPairings?(): TelegramPendingPairing[];
  approvePairing?(id: number): { ok: boolean; message: string };
  cancel(): Promise<void> | void;
}

export interface TelegramSetupWizardTheme {
  fg: (color: string, text: string) => string;
}

export interface TelegramSetupWizardOptions {
  tui: TUI;
  theme: TelegramSetupWizardTheme;
  controller: TelegramSetupController;
  done: (result: TelegramSetupResult) => void;
  signal?: AbortSignal;
}

export type TelegramSetupResult =
  | { status: "saved"; message: string }
  | { status: "cancelled" }
  | { status: "error"; message: string };

type WizardStep =
  | { kind: "start" }
  | { kind: "instructions" }
  | { kind: "token" }
  | { kind: "saving" }
  | { kind: "result"; ok: boolean; message: string }
  | { kind: "pairing" };

const START_OPTIONS = ["Yes, I have one", "Not yet — how to create one?", "Cancel"] as const;

const BOTFATHER_INSTRUCTIONS = [
  "Open Telegram and find @BotFather.",
  "Send /newbot, follow the instructions, then copy the token you receive.",
  "Come back here once the token is ready.",
];

const KEYPAD_DIGITS: Record<string, string> = {
  "\x1bOp": "0",
  "\x1bOq": "1",
  "\x1bOr": "2",
  "\x1bOs": "3",
  "\x1bOt": "4",
  "\x1bOu": "5",
  "\x1bOv": "6",
  "\x1bOw": "7",
  "\x1bOx": "8",
  "\x1bOy": "9",
};

/**
 * Question-tool-style wizard for Telegram channel setup.
 *
 * Every step is one question with numbered options (↑↓ navigate, Enter select,
 * Escape cancel). The token step uses a plain free-text editor — the credential
 * is intentionally not masked per the user's design choice — and the component
 * never returns the token to the session, only a safe status/message.
 */
export class TelegramSetupWizard implements Component {
  private readonly tui: TUI;
  private readonly theme: TelegramSetupWizardTheme;
  private readonly controller: TelegramSetupController;
  private readonly done: (result: TelegramSetupResult) => void;
  private readonly editor: Editor;

  private step: WizardStep = { kind: "start" };
  private optionIndex = 0;
  private approvalIndex = 0;
  private approvalInput = "";
  private approvalMessage = "";
  private savedMessage = "";
  private cachedLines: string[] | undefined;
  private settled = false;
  private busy = false;

  constructor(options: TelegramSetupWizardOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.controller = options.controller;
    this.done = options.done;

    const editorTheme = {
      borderColor: (text: string) => this.theme.fg("accent", text),
      selectList: {
        selectedPrefix: (text: string) => this.theme.fg("accent", text),
        selectedText: (text: string) => this.theme.fg("accent", text),
        description: (text: string) => this.theme.fg("muted", text),
        scrollInfo: (text: string) => this.theme.fg("dim", text),
        noMatch: (text: string) => this.theme.fg("warning", text),
      },
    };
    this.editor = new Editor(this.tui, editorTheme);
    this.editor.onSubmit = (value) => {
      void this.submit(value);
    };

    if (options.signal) {
      options.signal.addEventListener("abort", this.cancel, { once: true });
      if (options.signal.aborted) void this.cancel();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines) return this.cachedLines;

    const renderWidth = Math.max(1, Math.floor(width));
    const lines: string[] = [];

    const add = (prefix: string, text: string): void => {
      const prefixWidth = visibleWidth(prefix);
      if (prefixWidth >= renderWidth) {
        lines.push(...wrapTextWithAnsi(text, renderWidth));
        return;
      }
      const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
      const continuationPrefix = " ".repeat(prefixWidth);
      for (let i = 0; i < wrapped.length; i++) {
        lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
      }
    };
    const blank = (): void => { lines.push(""); };

    lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));

    switch (this.step.kind) {
      case "start":
        this.renderStart(add, blank);
        break;
      case "instructions":
        this.renderInstructions(add, blank);
        break;
      case "token":
        this.renderToken(add, blank, renderWidth, (line) => lines.push(line));
        break;
      case "saving":
        add(" ", this.theme.fg("muted", "Saving and connecting…"));
        break;
      case "result":
        this.renderResult(add, blank);
        break;
      case "pairing":
        this.renderPairing(add, blank);
        break;
    }

    lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));
    this.cachedLines = lines;
    return lines;
  }

  private renderStart(
    add: (prefix: string, text: string) => void,
    blank: () => void,
  ): void {
    add(" ", this.theme.fg("accent", "Telegram connection setup"));
    add(" ", this.theme.fg("text", "Do you already have a bot token?"));
    blank();
    for (let i = 0; i < START_OPTIONS.length; i++) {
      const selected = i === this.optionIndex;
      const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
      add(prefix, this.theme.fg(selected ? "accent" : "text", `${i + 1}. ${START_OPTIONS[i]}`));
    }
    blank();
    add(" ", this.theme.fg("dim", "↑↓ navigate • Enter select • Esc cancel"));
  }

  private renderInstructions(
    add: (prefix: string, text: string) => void,
    blank: () => void,
  ): void {
    add(" ", this.theme.fg("accent", "How to create a bot token"));
    for (const line of BOTFATHER_INSTRUCTIONS) {
      add(" ", this.theme.fg("text", line));
    }
    blank();
    const selected = this.optionIndex === 0;
    add(selected ? this.theme.fg("accent", "> ") : "  ", this.theme.fg(selected ? "accent" : "text", "1. Back"));
    blank();
    add(" ", this.theme.fg("dim", "Enter back • Esc cancel"));
  }

  private renderToken(
    add: (prefix: string, text: string) => void,
    blank: () => void,
    renderWidth: number,
    push: (line: string) => void,
  ): void {
    add(" ", this.theme.fg("accent", "Enter bot token"));
    add(" ", this.theme.fg("muted", "Token from @BotFather. It is never returned to the session."));
    blank();
    add(" ", this.theme.fg("text", "Bot token:"));
    for (const line of this.editor.render(Math.max(1, renderWidth - 2))) {
      const editorLine = ` ${line}`;
      if (visibleWidth(editorLine) <= renderWidth) {
        push(editorLine);
      } else {
        for (const wrappedLine of wrapTextWithAnsi(editorLine, renderWidth)) push(wrappedLine);
      }
    }
    blank();
    add(" ", this.theme.fg("dim", "Enter continue • Esc back"));
  }

  private renderResult(
    add: (prefix: string, text: string) => void,
    blank: () => void,
  ): void {
    const step = this.step as { ok: boolean; message: string };
    add(" ", this.theme.fg(step.ok ? "success" : "error", step.message || (step.ok ? "Telegram connection ready." : "Failed to connect.")));
    blank();
    const options = this.resultOptions();
    for (let i = 0; i < options.length; i++) {
      const selected = i === this.optionIndex;
      const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
      add(prefix, this.theme.fg(selected ? "accent" : "text", `${i + 1}. ${options[i]}`));
    }
    blank();
    add(" ", this.theme.fg("dim", "↑↓ navigate • Enter select • Esc cancel"));
  }

  private renderPairing(
    add: (prefix: string, text: string) => void,
    blank: () => void,
  ): void {
    add(" ", this.theme.fg("accent", "Telegram pairing approvals"));
    if (this.savedMessage) add(" ", this.theme.fg("success", this.savedMessage));
    if (this.approvalMessage) add(" ", this.theme.fg("success", this.approvalMessage));
    const pending = this.pendingPairings();
    if (pending.length === 0) {
      add(" ", this.theme.fg("text", "Telegram is connected."));
      add(" ", this.theme.fg("muted", "Send any message to the Telegram bot, then press Enter to check for pairing requests."));
      blank();
      add(" ", this.theme.fg("dim", "Enter check pairing • Esc finish"));
      return;
    }
    this.approvalIndex = Math.min(this.approvalIndex, pending.length - 1);
    for (const [index, request] of pending.entries()) {
      const selected = index === this.approvalIndex;
      const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
      add(prefix, this.theme.fg(selected ? "accent" : "text", `[${request.id}] user ${request.userId} — code ${request.code}`));
    }
    blank();
    add(" ", this.theme.fg("dim", "↑↓ select • Enter approve • Esc back"));
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.editor.invalidate();
  }

  handleInput(data: string): void {
    if (this.settled || this.busy) return;

    if (this.step.kind === "start") {
      if (matchesKey(data, Key.up)) {
        this.optionIndex = Math.max(0, this.optionIndex - 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.optionIndex = Math.min(START_OPTIONS.length - 1, this.optionIndex + 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const choice = START_OPTIONS[this.optionIndex]!;
        if (choice === "Yes, I have one") {
          this.enterTokenStep();
        } else if (choice === "Not yet — how to create one?") {
          this.optionIndex = 0;
          this.step = { kind: "instructions" };
          this.refresh();
        } else {
          void this.cancel();
        }
        return;
      }
      if (matchesKey(data, Key.escape)) {
        void this.cancel();
      }
      return;
    }

    if (this.step.kind === "instructions") {
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
        this.optionIndex = 0;
        this.step = { kind: "start" };
        this.refresh();
      }
      return;
    }

    if (this.step.kind === "token") {
      if (matchesKey(data, Key.escape)) {
        this.optionIndex = 0;
        this.step = { kind: "start" };
        this.refresh();
        return;
      }
      this.editor.handleInput(data);
      this.refresh();
      return;
    }

    if (this.step.kind === "result") {
      const options = this.resultOptions();
      if (matchesKey(data, Key.up)) {
        this.optionIndex = Math.max(0, this.optionIndex - 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.optionIndex = Math.min(options.length - 1, this.optionIndex + 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const choice = options[this.optionIndex]!;
        if (choice.startsWith("Approve pairing")) {
          this.approvalIndex = 0;
          this.approvalInput = "";
          this.step = { kind: "pairing" };
          this.refresh();
        } else if (choice === "Try again") {
          this.enterTokenStep();
        } else if (choice === "Done") {
          this.finish({ status: "saved", message: this.resultMessage() });
        } else {
          void this.cancel();
        }
        return;
      }
      if (matchesKey(data, Key.escape)) {
        void this.cancel();
      }
      return;
    }

    if (this.step.kind === "pairing") {
      const pending = this.pendingPairings();
      if (matchesKey(data, Key.escape)) {
        this.finish({ status: "saved", message: this.savedMessage });
        return;
      }
      if (pending.length === 0) {
        if (matchesKey(data, Key.enter)) {
          const refreshed = this.pendingPairings();
          if (refreshed.length > 0) {
            this.approvalIndex = 0;
            this.approvalInput = "";
            this.approvalMessage = "Pairing request found.";
          } else {
            this.approvalMessage = "No pairing request yet. Send a message to the bot, then press Enter again.";
          }
          this.refresh();
        }
        return;
      }
      if (matchesKey(data, Key.up)) {
        this.approvalIndex = Math.max(0, this.approvalIndex - 1);
        this.approvalInput = "";
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.approvalIndex = Math.min(Math.max(0, pending.length - 1), this.approvalIndex + 1);
        this.approvalInput = "";
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const typedId = Number(this.approvalInput);
        const id = this.approvalInput.length > 0 ? typedId : pending[this.approvalIndex]?.id;
        this.approvePairing(id ?? 0);
        return;
      }
      const printable = KEYPAD_DIGITS[data] ?? (data.length === 1 ? data : undefined);
      if (printable !== undefined && /^[0-9]+$/.test(printable)) {
        this.approvalInput += printable;
        this.refresh();
      }
      return;
    }
  }

  private enterTokenStep(): void {
    this.editor.setText(this.controller.getInitialToken());
    this.step = { kind: "token" };
    this.refresh();
  }

  private resultOptions(): string[] {
    if (this.step.kind === "result") {
      if (this.step.ok) {
        const options = ["Done"];
        const pending = this.pendingPairings();
        if (pending.length > 0) options.push(`Approve pairing (${pending.length})`);
        return options;
      }
      return ["Try again", "Cancel"];
    }
    return [];
  }

  private resultMessage(): string {
    return this.step.kind === "result" ? this.step.message : "";
  }

  private pendingPairings(): TelegramPendingPairing[] {
    return this.controller.listPendingPairings?.() ?? [];
  }

  private approvePairing(id: number): void {
    if (!this.controller.approvePairing) return;
    const result = this.controller.approvePairing(id);
    this.approvalMessage = result.message;
    if (result.ok) {
      if (this.pendingPairings().length > 0) {
        this.approvalIndex = Math.min(this.approvalIndex, this.pendingPairings().length - 1);
        this.approvalInput = "";
        this.refresh();
        return;
      }
      this.step = { kind: "result", ok: true, message: result.message };
    } else {
      this.step = { kind: "result", ok: false, message: result.message };
    }
    this.optionIndex = 0;
    this.refresh();
  }

  private async submit(value: string): Promise<void> {
    if (this.settled || this.busy) return;
    this.busy = true;
    this.step = { kind: "saving" };
    this.optionIndex = 0;
    this.refresh();
    const result = await this.controller.submitToken(value);
    if (this.settled) return;
    this.busy = false;
    if (result.ok) {
      this.savedMessage = result.message ?? "Telegram connection ready.";
      // Continue in the same wizard: if anyone already sent a pairing DM,
      // guide the operator straight into approval before finishing.
      if (this.pendingPairings().length > 0) {
        this.approvalIndex = 0;
        this.approvalInput = "";
        this.approvalMessage = "";
        this.step = { kind: "pairing" };
        this.refresh();
        return;
      }
      this.step = { kind: "pairing" };
      this.refresh();
      return;
    }
    this.step = { kind: "result", ok: false, message: result.message };
    this.refresh();
  }

  private readonly cancel = async (): Promise<void> => {
    if (this.settled) return;
    this.settled = true;
    await this.controller.cancel();
    this.done({ status: "cancelled" });
  };

  private finish(result: TelegramSetupResult): void {
    if (this.settled) return;
    this.settled = true;
    this.done(result);
  }

  private refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }
}