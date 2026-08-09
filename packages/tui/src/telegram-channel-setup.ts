import { Input, Key, matchesKey, type Component, type TUI, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type TelegramSetupStatus = "idle" | "validating" | "saving" | "ready" | "error";

/** UI-agnostic setup boundary structurally implemented by channels. */
export interface TelegramSetupController {
  getInitialToken(): string;
  submitToken(token: string): Promise<{ ok: true; message?: string } | { ok: false; message: string }>;
  cancel(): Promise<void> | void;
}

export interface TelegramChannelSetupTheme {
  fg: (color: string, text: string) => string;
}

export interface TelegramChannelSetupOptions {
  tui: TUI;
  theme: TelegramChannelSetupTheme;
  controller: TelegramSetupController;
  done: (result: TelegramSetupResult) => void;
  signal?: AbortSignal;
}

export type TelegramSetupResult =
  | { status: "saved"; message: string }
  | { status: "cancelled" }
  | { status: "error"; message: string };

/**
 * Dedicated non-model Telegram setup widget. The token input is always masked,
 * including after a successful submission; the component returns only a safe
 * setup status/message and never the credential itself.
 */
export class TelegramChannelSetup implements Component {
  private readonly tui: TUI;
  private readonly theme: TelegramChannelSetupTheme;
  private readonly controller: TelegramSetupController;
  private readonly done: (result: TelegramSetupResult) => void;
  private readonly input: Input;
  private cachedLines: string[] | undefined;
  private status: TelegramSetupStatus = "idle";
  private message = "";
  private settled = false;
  private submitting = false;

  constructor(options: TelegramChannelSetupOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.controller = options.controller;
    this.done = options.done;
    this.input = new Input();
    this.input.setValue(options.controller.getInitialToken());
    this.input.onSubmit = (value) => {
      void this.submit(value);
    };
    this.input.onEscape = () => {
      void this.cancel();
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
    const add = (text: string): void => {
      lines.push(...wrapTextWithAnsi(text, renderWidth));
    };

    lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));
    add(this.theme.fg("accent", "Telegram connection setup"));
    add(this.theme.fg("muted", "Enter a BotFather token. It is never displayed or returned."));
    lines.push("");
    add(this.theme.fg("text", "Bot token:"));

    const masked = "•".repeat(this.input.getValue().length);
    const inputLine = ` ${masked || this.theme.fg("dim", "(empty)")}`;
    lines.push(truncateToWidth(inputLine, renderWidth, "…"));

    if (this.status === "validating" || this.status === "saving") {
      add(this.theme.fg("muted", this.status === "validating" ? "Validating token…" : "Saving configuration…"));
    } else if (this.status === "error") {
      add(this.theme.fg("error", this.message));
    } else if (this.status === "ready") {
      add(this.theme.fg("success", this.message || "Telegram connection ready."));
    }

    lines.push("");
    add(this.theme.fg("dim", "Enter to connect • Esc to cancel"));
    lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.input.invalidate();
  }

  handleInput(data: string): void {
    if (this.settled || this.submitting) return;
    if (matchesKey(data, Key.escape)) {
      void this.cancel();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      void this.submit(this.input.getValue());
      return;
    }
    this.input.handleInput(data);
    this.refresh();
  }

  private readonly cancel = async (): Promise<void> => {
    if (this.settled) return;
    this.settled = true;
    await this.controller.cancel();
    this.done({ status: "cancelled" });
  };

  private async submit(value: string): Promise<void> {
    if (this.settled || this.submitting) return;
    this.submitting = true;
    this.status = "validating";
    this.message = "";
    this.refresh();
    const result = await this.controller.submitToken(value);
    if (this.settled) return;
    this.submitting = false;
    if (!result.ok) {
      this.status = "error";
      this.message = result.message;
      this.refresh();
      return;
    }
    this.status = "ready";
    this.message = result.message ?? "Telegram connection ready.";
    this.refresh();
    this.settled = true;
    this.done({ status: "saved", message: this.message });
  }

  private refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }
}
