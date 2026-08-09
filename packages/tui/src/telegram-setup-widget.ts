import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  type Component,
  type TUI,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { TelegramSetupController } from "./telegram-setup-controller.ts";

/** How the setup wizard ended, resolved through `done`. */
export type TelegramSetupResult =
  | { status: "configured" }
  | { status: "cancelled" }
  | { status: "timeout" }
  | { status: "error"; error: string };

export interface TelegramSetupWidgetOptions {
  tui: TUI;
  controller: TelegramSetupController;
  theme: {
    fg: (color: string, text: string) => string;
  };
  done: (result: TelegramSetupResult) => void;
  signal?: AbortSignal;
  /** Timeout for the discovery step, in seconds. Defaults to 120. */
  discoveryTimeoutSeconds?: number;
}

type TokenState =
  | { mode: "enter"; value: string }
  | { mode: "keep-replace"; choice: "keep" | "replace" };

const DISCOVERY_DONE = "Done discovering";

/**
 * Stateful multi-step Telegram setup wizard.
 *
 * Steps: token (entry or masked keep/replace) → validation → discovery (live
 * list of candidate chats with countdown and Done) → review (allow-list
 * checkboxes, default selection) → confirmation → result. The controller owns
 * all Telegram/state work; the widget owns presentation and keyboard input and
 * never sees the stored token.
 */
export class TelegramChannelSetup implements Component {
  private readonly tui: TUI;
  private readonly controller: TelegramSetupController;
  private readonly theme: TelegramSetupWidgetOptions["theme"];
  private readonly done: (result: TelegramSetupResult) => void;
  private readonly discoveryTimeoutSeconds: number;

  private step: "token" | "discovery" | "review" = "token";
  private tokenState: TokenState;
  private editor: Editor | undefined;
  private discovered: string[] = [];
  private defaultChatId: string | undefined;
  private allowed: Set<string>;
  private listIndex = 0;
  private countdown = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private error: string | undefined;
  private settled = false;
  private cachedLines: string[] | undefined;

  constructor(options: TelegramSetupWidgetOptions) {
    this.tui = options.tui;
    this.controller = options.controller;
    this.theme = options.theme;
    this.done = options.done;
    this.discoveryTimeoutSeconds = options.discoveryTimeoutSeconds ?? 120;
    const initialState = this.controller.getState();
    this.tokenState = initialState.hasExistingToken
      ? { mode: "keep-replace", choice: "keep" }
      : { mode: "enter", value: "" };
    this.defaultChatId = initialState.defaultChatId;
    this.allowed = new Set(initialState.allowedChatIds);
    this.discovered = [...initialState.candidates];
    if (this.tokenState.mode === "enter") {
      this.editor = new Editor(this.tui, this.editorTheme());
      this.editor.onSubmit = (value) => void this.submitToken(value);
    }

    if (options.signal) {
      options.signal.addEventListener("abort", () => this.finish({ status: "cancelled" }), { once: true });
    }
  }

  render(width: number): string[] {
    if (this.cachedLines) return this.cachedLines;
    const renderWidth = Math.max(1, Math.floor(width));
    const lines: string[] = [];
    const addWrapped = (text: string): void => {
      lines.push(...wrapTextWithAnsi(text, renderWidth));
    };
    lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));
    addWrapped(this.theme.fg("accent", "Telegram channel setup"));

    if (this.step === "token") {
      this.renderTokenStep(lines, renderWidth, addWrapped);
    } else if (this.step === "discovery") {
      this.renderDiscoveryStep(lines, addWrapped);
    } else {
      this.renderReviewStep(lines, renderWidth, addWrapped);
    }

    if (this.error) {
      lines.push("");
      addWrapped(this.theme.fg("warning", this.error));
    }
    lines.push("");
    addWrapped(this.theme.fg("dim", this.helpLine()));
    lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));
    this.cachedLines = lines;
    return lines;
  }

  private renderTokenStep(
    lines: string[],
    renderWidth: number,
    addWrapped: (text: string) => void,
  ): void {
    if (this.tokenState.mode === "keep-replace") {
      addWrapped(this.theme.fg("text", "An existing bot token is configured."));
      addWrapped(this.theme.fg("muted", "The stored token is never shown; keep it or replace it."));
      lines.push("");
      const options: Array<{ label: string; accent: boolean }> = [
        { label: "Keep existing token", accent: this.tokenState.choice === "keep" },
        { label: "Replace token", accent: this.tokenState.choice === "replace" },
      ];
      for (const option of options) {
        addWrapped(
          `${option.accent ? this.theme.fg("accent", "> ") : "  "}${this.theme.fg(option.accent ? "accent" : "text", option.label)}`,
        );
      }
      return;
    }
    addWrapped(this.theme.fg("text", "Enter the bot token from @BotFather."));
    addWrapped(this.theme.fg("muted", "Characters are masked as you type."));
    lines.push("");
    const editor = this.editor!;
    addWrapped(" ");
    for (const line of editor.render(Math.max(1, renderWidth - 2))) {
      addWrapped(` ${line}`);
    }
  }

  private renderDiscoveryStep(lines: string[], addWrapped: (text: string) => void): void {
    addWrapped(
      this.theme.fg(
        "text",
        `Send a test message from each chat you want to allow (${this.countdown}s remaining).`,
      ),
    );
    lines.push("");
    if (this.discovered.length === 0) {
      addWrapped(this.theme.fg("muted", "No chats observed yet."));
    } else {
      for (let i = 0; i < this.discovered.length; i++) {
        const selected = i === this.listIndex;
        const label = `${this.discovered[i]}${this.controller.getState().allowedChatIds.includes(this.discovered[i]!) ? " (existing)" : ""}`;
        addWrapped(`${selected ? this.theme.fg("accent", "> ") : "  "}${this.theme.fg("text", label)}`);
      }
    }
    lines.push("");
    addWrapped(
      this.theme.fg(
        this.listIndex === this.discovered.length ? "accent" : "dim",
        `${this.listIndex === this.discovered.length ? "> " : "  "}${DISCOVERY_DONE}`,
      ),
    );
  }

  private renderReviewStep(lines: string[], renderWidth: number, addWrapped: (text: string) => void): void {
    addWrapped(this.theme.fg("text", "Choose allowed chats and the default chat."));
    addWrapped(this.theme.fg("muted", "Toggle with Enter on a checkbox row."));
    lines.push("");
    const entries = [
      ...this.discovered.map((id) => ({ id, existing: this.controller.getState().allowedChatIds.includes(id) })),
    ];
    const shown = [...entries, { id: "(done)", existing: false }];
    for (let i = 0; i < shown.length; i++) {
      const entry = shown[i]!;
      const selected = i === this.listIndex;
      if (entry.id === "(done)") {
        addWrapped(
          `${selected ? this.theme.fg("accent", "> ") : "  "}${this.theme.fg("text", "Confirm and save")}`,
        );
        continue;
      }
      const checked = this.allowed.has(entry.id) ? "☑" : "☐";
      const isDefault = this.defaultChatId === entry.id ? " ★" : "";
      const row = `${selected ? this.theme.fg("accent", "> ") : "  "}${checked} ${entry.id}${entry.existing ? " (existing)" : ""}${isDefault}`;
      addWrapped(selected ? this.theme.fg("accent", row) : this.theme.fg("text", row));
    }
    if (this.defaultChatId === undefined) {
      lines.push("");
      addWrapped(this.theme.fg("muted", "No default chat selected — it must be in the allow-list."));
    }
  }

  handleInput(data: string): void {
    if (this.settled) return;
    if (matchesKey(data, Key.escape)) {
      void this.controller.cancel();
      this.finish({ status: "cancelled" });
      return;
    }
    if (this.step === "token") {
      this.handleTokenInput(data);
      return;
    }
    if (this.step === "discovery") {
      this.handleDiscoveryInput(data);
      return;
    }
    this.handleReviewInput(data);
  }

  private async submitToken(value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) return;
    const result = await this.controller.setToken(trimmed);
    if (result.ok) {
      this.error = undefined;
      this.step = "discovery";
      this.countdown = this.discoveryTimeoutSeconds;
      this.startTimer();
    } else {
      this.error = result.error;
    }
    this.refresh();
  }

  private handleTokenInput(data: string): void {
    if (this.tokenState.mode === "keep-replace") {
      if (matchesKey(data, Key.down)) {
        this.tokenState = { mode: "keep-replace", choice: "replace" };
        this.refresh();
      } else if (matchesKey(data, Key.up)) {
        this.tokenState = { mode: "keep-replace", choice: "keep" };
        this.refresh();
      } else if (matchesKey(data, Key.enter)) {
        const result =
          this.tokenState.choice === "keep" ? this.controller.keepToken() : undefined;
        if (this.tokenState.choice === "keep" && result && !result.ok) {
          this.error = result.error;
          this.refresh();
          return;
        }
        this.step = "discovery";
        this.countdown = this.discoveryTimeoutSeconds;
        this.startTimer();
        this.refresh();
      }
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.editor?.onSubmit?.(this.editor.getText?.() ?? "");
      return;
    }
    this.editor?.handleInput(data);
    this.refresh();
  }

  private handleDiscoveryInput(data: string): void {
    const total = this.discovered.length + 1;
    if (matchesKey(data, Key.down)) {
      this.listIndex = Math.min(total - 1, this.listIndex + 1);
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.listIndex = Math.max(0, this.listIndex - 1);
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.listIndex >= this.discovered.length) {
        // Done discovering
        this.stopTimer();
        this.listIndex = 0;
        this.step = "review";
        this.refresh();
      }
    }
  }

  private handleReviewInput(data: string): void {
    const rows = this.discovered.length + 1;
    if (matchesKey(data, Key.down)) {
      this.listIndex = Math.min(rows - 1, this.listIndex + 1);
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.listIndex = Math.max(0, this.listIndex - 1);
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.listIndex >= this.discovered.length) {
        void this.confirmAndSave();
        return;
      }
      const id = this.discovered[this.listIndex]!;
      const allowed = !this.allowed.has(id);
      if (allowed) this.allowed.add(id);
      else this.allowed.delete(id);
      this.controller.setAllowedChat(id, allowed);
      if (!allowed && this.defaultChatId === id) {
        this.defaultChatId = undefined;
      }
      this.refresh();
    }
  }

  private async confirmAndSave(): Promise<void> {
    if (this.defaultChatId === undefined) {
      this.error = "Select a default chat before saving.";
      this.refresh();
      return;
    }
    const result = await this.controller.confirm();
    if (result.ok) {
      this.finish({ status: "configured" });
    } else {
      this.error = result.error;
      this.refresh();
    }
  }

  /** Called by the host when the controller observes a new chat during discovery. */
  observeDiscovered(chatId: string): void {
    if (this.step !== "discovery") return;
    this.discovered.push(chatId);
    this.controller.acceptDiscoveredChat(chatId);
    this.refresh();
  }

  /** Select the default chat from the review list (host-driven or keyboard). */
  selectDefault(chatId: string): void {
    const result = this.controller.setDefaultChat(chatId);
    if (result.ok) this.defaultChatId = chatId;
    else this.error = result.error;
    this.refresh();
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => {
      this.countdown -= 1;
      if (this.countdown <= 0) {
        this.stopTimer();
        void this.controller.cancel();
        this.finish({ status: "timeout" });
        return;
      }
      this.refresh();
    }, 1000);
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private editorTheme(): EditorTheme {
    return {
      borderColor: (text) => this.theme.fg("accent", text),
      selectList: {
        selectedPrefix: (text) => this.theme.fg("accent", text),
        selectedText: (text) => this.theme.fg("accent", text),
        description: (text) => this.theme.fg("muted", text),
        scrollInfo: (text) => this.theme.fg("dim", text),
        noMatch: (text) => this.theme.fg("warning", text),
      },
    };
  }

  private helpLine(): string {
    if (this.step === "token") {
      return this.tokenState.mode === "keep-replace"
        ? "↑↓ choose • Enter confirm • Esc cancel"
        : "Type the token (masked) • Enter validate • Esc cancel";
    }
    if (this.step === "discovery") {
      return "↑↓ move • Enter select/Done • Esc cancel";
    }
    return "↑↓ move • Enter toggle/confirm • Esc cancel";
  }

  invalidate(): void {
    this.cachedLines = undefined;
  }

  /** Stop the discovery timer and pending async work. */
  dispose(): void {
    this.stopTimer();
  }

  private refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  private finish(result: TelegramSetupResult): void {
    if (this.settled) return;
    this.settled = true;
    this.stopTimer();
    this.done(result);
  }

  /** Alias so the host can stop the widget on teardown. */
  destroy(): void {
    this.dispose();
  }
}