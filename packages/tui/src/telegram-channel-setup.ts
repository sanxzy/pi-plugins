import { Input, Key, decodeKittyPrintable, matchesKey, parseKey, type Component, type TUI, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// Application keypad (DECNKM) sends SS3 sequences for the numpad digits:
// ESC O p..y map to 0..9. pi-tui's decoder does not normalize these, so the
// approval input maps them explicitly.
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

export type TelegramSetupStatus = "idle" | "validating" | "saving" | "ready" | "error";

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
  private approvalMode = false;
  private approvalIndex = 0;
  private approvalInput = "";

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
    if (this.approvalMode) {
      this.renderApprovals(add);
    } else {
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
      const pending = this.pendingPairings();
      if (pending.length > 0) {
        add(this.theme.fg("warning", `${pending.length} pending pairing request${pending.length === 1 ? "" : "s"} — press a to approve`));
      }
      add(this.theme.fg("dim", "Enter to connect • Esc to cancel"));
    }
    lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));
    this.cachedLines = lines;
    return lines;
  }

  private renderApprovals(add: (text: string) => void): void {
    add(this.theme.fg("accent", "Telegram pairing approvals"));
    const pending = this.pendingPairings();
    if (pending.length === 0) {
      add(this.theme.fg("text", "No pending pairing requests."));
    } else {
      this.approvalIndex = Math.min(this.approvalIndex, pending.length - 1);
      for (const [index, request] of pending.entries()) {
        const prefix = index === this.approvalIndex ? "> " : "  ";
        add(this.theme.fg(index === this.approvalIndex ? "accent" : "text", `${prefix}[${request.id}] user ${request.userId} — code ${request.code}`));
      }
      add(this.theme.fg("dim", "↑↓ select • Enter approve • type ID also supported • Esc return"));
    }
    if (this.status === "ready") {
      add(this.theme.fg("success", this.message));
    } else if (this.status === "error") {
      add(this.theme.fg("error", this.message));
    }
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.input.invalidate();
  }

  handleInput(data: string): void {
    if (this.settled || this.submitting) return;
    if (matchesKey(data, Key.escape)) {
      if (this.approvalMode) {
        this.approvalMode = false;
        this.approvalInput = "";
        this.message = "";
        this.invalidate();
        this.tui.requestRender();
      } else {
        void this.cancel();
      }
      return;
    }
    if (!this.approvalMode && (data === "a" || data === "A") && this.pendingPairings().length > 0) {
      this.approvalMode = true;
      this.approvalIndex = 0;
      this.status = "idle";
      this.message = "";
      this.refresh();
      return;
    }
    if (this.approvalMode) {
      const pending = this.pendingPairings();
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
        const result = this.approvePairing(id ?? 0);
        this.status = result.ok ? "ready" : "error";
        this.message = result.message;
        this.approvalInput = "";
        this.refresh();
        if (result.ok) {
          this.settled = true;
          this.done({ status: "saved", message: result.message });
        }
        return;
      }
      const printable = KEYPAD_DIGITS[data] ?? decodeKittyPrintable(data) ?? (data.length === 1 ? data : undefined) ?? parseKey(data);
      if (printable !== undefined && /^[0-9]+$/.test(printable)) {
        this.approvalInput += printable;
        this.refresh();
      }
      return;
    }
    if (matchesKey(data, Key.enter)) {
      void this.submit(this.input.getValue());
      return;
    }
    this.input.handleInput(data);
    this.refresh();
  }

  private pendingPairings(): TelegramPendingPairing[] {
    return this.controller.listPendingPairings?.() ?? [];
  }

  private approvePairing(id: number): { ok: boolean; message: string } {
    if (!this.controller.approvePairing) return { ok: false, message: "Pairing approval is unavailable" };
    return this.controller.approvePairing(id);
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
