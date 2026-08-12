import {
  Editor,
  Key,
  matchesKey,
  type Component,
  type TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

/** An item from the controller that is not a reference we can edit. */
export interface ReferencesSetupItem {
  readonly name: string;
  readonly label: string;
  /** Raw local details when the entry is a local reference (object or shorthand). */
  readonly local?: { path: string; description?: string; hidden?: boolean };
}

/** A single field editor, driven sequentially by the wizard. */
type WizardStep =
  | { kind: "menu" }
  | { kind: "select-edit" }
  | { kind: "alias" }
  | { kind: "path" }
  | { kind: "description" }
  | { kind: "hidden" }
  | { kind: "busy"; message: string }
  | { kind: "result"; ok: boolean; message: string }
  | { kind: "error"; message: string };

export interface ReferencesSetupController {
  list(): Promise<{ items: readonly ReferencesSetupItem[] }>;
  addLocal(input: { alias: string; path: string; description?: string; hidden?: boolean; signal?: AbortSignal }): Promise<{ ok: true; message: string } | { ok: false; message: string }>;
  updateLocal(alias: string, input: { path: string; description?: string; hidden?: boolean; signal?: AbortSignal }): Promise<{ ok: true; message: string } | { ok: false; message: string }>;
  remove(alias: string, signal?: AbortSignal): Promise<{ ok: true; message: string } | { ok: false; message: string }>;
  cancel(): Promise<void>;
}

export interface ReferencesSetupWizardOptions {
  tui: TUI;
  theme: { fg: (color: string, text: string) => string };
  controller: ReferencesSetupController;
  done: (result: ReferencesSetupResult) => void;
  signal?: AbortSignal;
}

export type ReferencesSetupResult = { status: "saved"; message: string } | { status: "cancelled" } | { status: "error"; message: string };

export class ReferencesSetupWizard implements Component {
  private readonly tui: TUI;
  private readonly theme: NonNullable<ReferencesSetupWizardOptions["theme"]>;
  private readonly controller: ReferencesSetupController;
  private readonly done: (result: ReferencesSetupResult) => void;
  private readonly editor: Editor;

  private step: WizardStep = { kind: "menu" };
  private alias = "";
  private path = "";
  private description = "";
  private hidden = false;
  private hiddenTouched = false;
  private editAlias: string | null = null;
  private items: readonly ReferencesSetupItem[] = [];
  private optionIndex = 0;
  private statusMessage = "";
  private cachedLines: string[] | undefined;
  private settled = false;
  private busy = false;

  constructor(options: ReferencesSetupWizardOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.controller = options.controller;
    this.done = options.done;
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
      const result = await this.controller.list();
      this.items = result.items;
    } catch {
      this.items = [];
    }
    this.refresh();
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
        add(" ", this.theme.fg("accent", "References setup"));
        if (this.statusMessage) add(" ", this.theme.fg("success", this.statusMessage));
        const options = ["Add local reference", "Add Git reference (later)", "Edit", "Remove", "Done"];
        if (this.items.length === 0) {
          add(" ", this.theme.fg("muted", "No references configured yet."));
        }
        for (let i = 0; i < options.length; i++) {
          const selected = i === this.optionIndex;
          add(selected ? this.theme.fg("accent", "> ") : "  ", this.theme.fg(selected ? "accent" : "text", `${i + 1}. ${options[i]}`));
        }
        add(" ", this.theme.fg("dim", "↑↓ navigate • Enter select • Esc cancel"));
        break;
      }
      case "select-edit": {
        add(" ", this.theme.fg("accent", "References setup · edit"));
        const editable = this.editableItems();
        if (editable.length === 0) {
          add(" ", this.theme.fg("muted", "No local references to edit."));
        } else {
          for (let i = 0; i < editable.length; i++) {
            const selected = i === this.optionIndex;
            add(selected ? this.theme.fg("accent", "> ") : "  ", this.theme.fg(selected ? "accent" : "text", `${i + 1}. ${editable[i]!.name} — ${editable[i]!.label}`));
          }
        }
        add(" ", this.theme.fg("dim", "↑↓ navigate • Enter edit • Esc back"));
        break;
      }
      case "alias": {
        add(" ", this.theme.fg("accent", `Add local reference · alias`));
        add(" ", this.theme.fg("muted", "Unique alias to identify this reference."));
        add(" ", this.theme.fg("text", this.promptText("Reference alias:")));
        for (const line of this.editor.render(Math.max(1, renderWidth - 2))) add(" ", line);
        add(" ", this.theme.fg("dim", "Enter continue • Esc back"));
        break;
      }
      case "path": {
        add(" ", this.theme.fg("accent", `${this.editAlias ? "Edit" : "Add"} local reference · path`));
        add(" ", this.theme.fg("muted", "Absolute path or ~/ relative path."));
        add(" ", this.theme.fg("text", this.promptText("Path:")));
        for (const line of this.editor.render(Math.max(1, renderWidth - 2))) add(" ", line);
        add(" ", this.theme.fg("dim", "Enter continue • Esc back"));
        break;
      }
      case "description": {
        add(" ", this.theme.fg("accent", `${this.editAlias ? "Edit" : "Add"} local reference · description`));
        add(" ", this.theme.fg("muted", "Optional description."));
        add(" ", this.theme.fg("text", this.promptText("Description (optional):")));
        for (const line of this.editor.render(Math.max(1, renderWidth - 2))) add(" ", line);
        add(" ", this.theme.fg("dim", "Enter continue • Esc back"));
        break;
      }
      case "hidden": {
        add(" ", this.theme.fg("accent", `${this.editAlias ? "Edit" : "Add"} local reference · hidden`));
        const option = this.hidden ? "Hide from discovery" : "Show in discovery";
        add(" ", this.theme.fg(this.hidden ? "accent" : "text", `Current: ${option}`));
        const options = ["Show", "Hide", "Continue"];
        for (let i = 0; i < options.length; i++) {
          const selected = i === this.optionIndex;
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
    return this.step.kind === "alias" || this.step.kind === "path" || this.step.kind === "description" ? `${prompt} ${this.editor.getText()}`.trim() : prompt;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.editor.invalidate();
  }

  handleInput(data: string): void {
    if (this.settled || this.busy) return;
    if (this.step.kind === "select-edit") {
      const editable = this.editableItems();
      if (matchesKey(data, Key.up)) {
        this.optionIndex = Math.max(0, this.optionIndex - 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.optionIndex = Math.min(editable.length - 1, this.optionIndex + 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.step = { kind: "menu" };
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const item = editable[this.optionIndex];
        if (item) this.startEdit(item);
      }
      return;
    }
    if (this.step.kind === "hidden") {
      if (matchesKey(data, Key.up)) {
        this.optionIndex = Math.max(0, this.optionIndex - 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.optionIndex = Math.min(2, this.optionIndex + 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        if (this.optionIndex === 0) {
          this.hidden = false;
          this.hiddenTouched = true;
        } else if (this.optionIndex === 1) {
          this.hidden = true;
          this.hiddenTouched = true;
        }
        void this.submitLocal();
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.step = { kind: "description" };
        this.editor.setText(this.description);
        this.refresh();
        return;
      }
      return;
    }
    if (this.step.kind === "result" || this.step.kind === "error") {
      if (matchesKey(data, Key.enter)) {
        if (this.step.kind === "result" && !this.step.ok) this.retryFromResult();
        else this.returnToMenu();
      } else if (matchesKey(data, Key.escape)) {
        this.returnToMenu();
      }
      return;
    }
    if (this.step.kind === "alias") {
      if (matchesKey(data, Key.escape)) {
        this.returnToMenu();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.alias = this.editor.getText();
        this.editor.setText("");
        this.step = { kind: "path" };
        this.refresh();
        return;
      }
      this.editor.handleInput(data);
      this.refresh();
      return;
    }
    if (this.step.kind === "path") {
      if (matchesKey(data, Key.escape)) {
        this.step = { kind: "alias" };
        this.editor.setText(this.alias);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.path = this.editor.getText();
        this.editor.setText("");
        this.step = { kind: "description" };
        this.editor.setText(this.description);
        this.refresh();
        return;
      }
      this.editor.handleInput(data);
      this.refresh();
      return;
    }
    if (this.step.kind === "description") {
      if (matchesKey(data, Key.escape)) {
        this.step = { kind: "path" };
        this.editor.setText(this.path);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.description = this.editor.getText();
        this.editor.setText("");
        this.optionIndex = this.editAlias ? 2 : 0;
        this.step = { kind: "hidden" };
        this.refresh();
        return;
      }
      this.editor.handleInput(data);
      this.refresh();
      return;
    }
    if (this.step.kind === "menu") {
      if (matchesKey(data, Key.up)) {
        this.optionIndex = Math.max(0, this.optionIndex - 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.optionIndex = Math.min(4, this.optionIndex + 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.escape)) {
        void this.cancel();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const option = this.optionIndex;
        if (option === 0) {
          this.setIdentification();
        } else if (option === 2) {
          const editable = this.editableItems();
          if (editable.length === 0) {
            this.statusMessage = "No local references to edit.";
            this.refresh();
          } else {
            this.statusMessage = "";
            this.optionIndex = 0;
            this.step = { kind: "select-edit" };
            this.refresh();
          }
        } else if (option === 4) {
          this.finish({ status: "saved", message: "References setup complete." });
        } else if (option === 3) {
          this.startRemove();
        } else {
          this.statusMessage = "Not available in this build yet.";
          this.refresh();
        }
      }
      return;
    }
  }

  private setIdentification(): void {
    this.alias = "";
    this.path = "";
    this.description = "";
    this.hidden = false;
    this.hiddenTouched = false;
    this.editAlias = null;
    this.statusMessage = "";
    this.editor.setText("");
    this.step = { kind: "alias" };
    this.refresh();
  }

  private editableItems(): readonly ReferencesSetupItem[] {
    return this.items.filter((item) => item.local !== undefined);
  }

  private startEdit(item: ReferencesSetupItem): void {
    this.editAlias = item.name;
    this.path = item.local!.path;
    this.description = item.local!.description ?? "";
    this.hidden = item.local!.hidden ?? false;
    this.hiddenTouched = false;
    this.optionIndex = 2; // Continue keeps raw hidden metadata unchanged.
    this.statusMessage = "";
    this.editor.setText(this.path);
    this.step = { kind: "path" };
    this.refresh();
  }

  private retryFromResult(): void {
    if (this.editAlias) {
      this.editor.setText(this.path);
      this.optionIndex = 2;
      this.step = { kind: "path" };
    } else {
      this.editor.setText(this.alias);
      this.step = { kind: "alias" };
    }
    this.refresh();
  }

  private startRemove(): void {
    const alias = this.items[this.optionIndex]?.name;
    if (!alias) return;
    this.editor.setText(alias);
    this.step = { kind: "error", message: `Not available in this build yet. Remove "${alias}".` };
    this.refresh();
  }

  private async submitLocal(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.step = { kind: "busy", message: "Saving reference…" };
    this.refresh();
    const description = this.description || undefined;
    const hidden = this.hiddenTouched ? this.hidden : undefined;
    const input: { path: string; description?: string; hidden?: boolean } = { path: this.path };
    if (description !== undefined) input.description = description;
    if (hidden !== undefined) input.hidden = hidden;
    const result = this.editAlias
      ? await this.controller.updateLocal(this.editAlias, input)
      : await this.controller.addLocal({ alias: this.alias, ...input });
    if (this.settled) return;
    this.busy = false;
    if (result.ok) this.statusMessage = result.message;
    this.step = { kind: "result", ok: result.ok, message: result.message };
    this.optionIndex = 0;
    if (result.ok) void this.load();
    this.refresh();
  }

  private returnToMenu(): void {
    this.editor.setText("");
    this.editAlias = null;
    this.hiddenTouched = false;
    this.step = { kind: "menu" };
    this.refresh();
  }

  private readonly cancel = async (): Promise<void> => {
    if (this.settled) return;
    this.settled = true;
    await this.controller.cancel();
    this.done({ status: "cancelled" });
  };

  private finish(result: ReferencesSetupResult): void {
    if (this.settled) return;
    this.settled = true;
    this.done(result);
  }

  private refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }
}
