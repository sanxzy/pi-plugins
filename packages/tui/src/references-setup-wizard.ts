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
  /** Raw Git details when the entry is a Git reference. */
  readonly git?: { repository: string; branch?: string; description?: string; hidden?: boolean };
}

/** A single field editor, driven sequentially by the wizard. */
type WizardStep =
  | { kind: "menu" }
  | { kind: "select-edit" }
  | { kind: "select-operation"; name: string; isGit: boolean }
  | { kind: "alias"; form: "local" | "git" }
  | { kind: "path" }
  | { kind: "repository" }
  | { kind: "branch" }
  | { kind: "description" }
  | { kind: "hidden" }
  | { kind: "busy"; message: string }
  | { kind: "result"; ok: boolean; message: string }
  | { kind: "error"; message: string };

export type ReferencesMutationResult =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly message: string };

export type ReferencesOperationResult =
  | { readonly ok: true; readonly message: string; readonly materialization?: string; readonly branch?: string; readonly head?: string }
  | { readonly ok: false; readonly message: string };

export interface ReferencesSetupController {
  list(): Promise<{ items: readonly ReferencesSetupItem[] }>;
  addLocal(input: { alias: string; path: string; description?: string; hidden?: boolean; signal?: AbortSignal }): Promise<ReferencesMutationResult>;
  updateLocal(alias: string, input: { path: string; description?: string; hidden?: boolean; signal?: AbortSignal }): Promise<ReferencesMutationResult>;
  addGit?: (input: { alias: string; repository: string; branch?: string; description?: string; hidden?: boolean; signal?: AbortSignal }) => Promise<ReferencesMutationResult>;
  updateGit?: (alias: string, input: { repository: string; branch?: string; description?: string; hidden?: boolean; signal?: AbortSignal }) => Promise<ReferencesMutationResult>;
  testGit?: (alias: string, signal?: AbortSignal) => Promise<ReferencesOperationResult>;
  refreshGit?: (alias: string, signal?: AbortSignal) => Promise<ReferencesOperationResult>;
  remove(alias: string, signal?: AbortSignal): Promise<ReferencesMutationResult>;
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
  private readonly signal?: AbortSignal;
  private readonly editor: Editor;

  private step: WizardStep = { kind: "menu" };
  private form: "local" | "git" = "local";
  private alias = "";
  private path = "";
  private repository = "";
  private branch = "";
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
        const options = ["Add local reference", "Add Git reference", "Edit", "Remove", "Done"];
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
          add(" ", this.theme.fg("muted", "No references to edit."));
        } else {
          for (let i = 0; i < editable.length; i++) {
            const item = editable[i]!;
            const badge = item.local ? "local" : "git";
            const selected = i === this.optionIndex;
            add(selected ? this.theme.fg("accent", "> ") : "  ", this.theme.fg(selected ? "accent" : "text", `${i + 1}. ${badge} ${item.name} — ${item.label}`));
          }
        }
        add(" ", this.theme.fg("dim", "↑↓ navigate • Enter select • Esc back"));
        break;
      }
      case "select-operation": {
        const opStep = this.step.kind === "select-operation" ? this.step : null;
        add(" ", this.theme.fg("accent", `References setup · ${opStep?.name}`));
        const options = opStep?.isGit ? ["Edit", "Test", "Refresh"] : ["Edit"];
        for (let i = 0; i < options.length; i++) {
          const selected = i === this.optionIndex;
          add(selected ? this.theme.fg("accent", "> ") : "  ", this.theme.fg(selected ? "accent" : "text", `${i + 1}. ${options[i]}`));
        }
        add(" ", this.theme.fg("dim", "↑↓ navigate • Enter select • Esc back"));
        break;
      }
      case "alias": {
        const target = this.step.form === "git" ? "Git" : "local";
        add(" ", this.theme.fg("accent", `${this.editing() ? "Edit" : "Add"} ${target} reference · alias`));
        add(" ", this.theme.fg("muted", "Unique alias to identify this reference."));
        add(" ", this.theme.fg("text", this.promptText("Reference alias:")));
        for (const line of this.editor.render(Math.max(1, renderWidth - 2))) add(" ", line);
        add(" ", this.theme.fg("dim", "Enter continue • Esc back"));
        break;
      }
      case "path": {
        add(" ", this.theme.fg("accent", `${this.editing() ? "Edit" : "Add"} local reference · path`));
        add(" ", this.theme.fg("muted", "Absolute path or ~/ relative path."));
        add(" ", this.theme.fg("text", this.promptText("Path:")));
        for (const line of this.editor.render(Math.max(1, renderWidth - 2))) add(" ", line);
        add(" ", this.theme.fg("dim", "Enter continue • Esc back"));
        break;
      }
      case "repository": {
        add(" ", this.theme.fg("accent", `${this.editing() ? "Edit" : "Add"} Git reference · repository`));
        add(" ", this.theme.fg("muted", "Shorthand like owner/repo, a URL, or an scp-style remote."));
        add(" ", this.theme.fg("text", this.promptText("Repository:")));
        for (const line of this.editor.render(Math.max(1, renderWidth - 2))) add(" ", line);
        add(" ", this.theme.fg("dim", "Enter continue • Esc back"));
        break;
      }
      case "branch": {
        add(" ", this.theme.fg("accent", `${this.editing() ? "Edit" : "Add"} Git reference · branch`));
        add(" ", this.theme.fg("muted", "Optional branch to check out. Leave empty for the default."));
        add(" ", this.theme.fg("text", this.promptText("Branch (optional):")));
        for (const line of this.editor.render(Math.max(1, renderWidth - 2))) add(" ", line);
        add(" ", this.theme.fg("dim", "Enter continue • Esc back"));
        break;
      }
      case "description": {
        add(" ", this.theme.fg("accent", `${this.editing() ? "Edit" : "Add"} ${this.form === "git" ? "Git" : "local"} reference · description`));
        add(" ", this.theme.fg("muted", "Optional description."));
        add(" ", this.theme.fg("text", this.promptText("Description (optional):")));
        for (const line of this.editor.render(Math.max(1, renderWidth - 2))) add(" ", line);
        add(" ", this.theme.fg("dim", "Enter continue • Esc back"));
        break;
      }
      case "hidden": {
        add(" ", this.theme.fg("accent", `${this.editing() ? "Edit" : "Add"} ${this.form === "git" ? "Git" : "local"} reference · hidden`));
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

  private editing(): boolean {
    return this.editAlias !== null;
  }

  private promptText(prompt: string): string {
    return this.step.kind === "alias" || this.step.kind === "path" || this.step.kind === "repository" || this.step.kind === "branch" || this.step.kind === "description"
      ? `${prompt} ${this.editor.getText()}`.trim()
      : prompt;
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
        if (item) {
          this.optionIndex = 0;
          if (item.git) {
            this.step = { kind: "select-operation", name: item.name, isGit: true };
            this.refresh();
          } else {
            this.startEdit(item);
          }
        }
      }
      return;
    }
    if (this.step.kind === "select-operation") {
      const opName = this.step.kind === "select-operation" ? this.step.name : "";
      const item = this.items.find((entry) => entry.name === opName);
      if (matchesKey(data, Key.up)) {
        this.optionIndex = Math.max(0, this.optionIndex - 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.optionIndex = Math.min(this.step.isGit ? 2 : 0, this.optionIndex + 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.step = { kind: "select-edit" };
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        if (this.optionIndex === 0) {
          if (item) this.startEdit(item);
        } else if (this.optionIndex === 1 && item) {
          void this.runOperation(item.name, false);
        } else if (this.optionIndex === 2 && item) {
          void this.runOperation(item.name, true);
        }
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
        void this.submitForm();
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
        this.step = this.step.form === "git" ? { kind: "repository" } : { kind: "path" };
        this.refresh();
        return;
      }
      this.editor.handleInput(data);
      this.refresh();
      return;
    }
    if (this.step.kind === "path") {
      if (matchesKey(data, Key.escape)) {
        this.step = { kind: "alias", form: "local" };
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
    if (this.step.kind === "repository") {
      if (matchesKey(data, Key.escape)) {
        this.step = { kind: "alias", form: "git" };
        this.editor.setText(this.alias);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.repository = this.editor.getText();
        this.editor.setText("");
        this.step = { kind: "branch" };
        this.editor.setText(this.branch);
        this.refresh();
        return;
      }
      this.editor.handleInput(data);
      this.refresh();
      return;
    }
    if (this.step.kind === "branch") {
      if (matchesKey(data, Key.escape)) {
        this.step = { kind: "repository" };
        this.editor.setText(this.repository);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.branch = this.editor.getText();
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
        this.step = this.form === "git" ? { kind: "branch" } : { kind: "path" };
        this.editor.setText(this.form === "git" ? this.branch : this.path);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.description = this.editor.getText();
        this.editor.setText("");
        this.optionIndex = this.editing() ? 2 : 0;
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
          this.startLocalAdd();
        } else if (option === 1) {
          if (this.controller.addGit) this.startGitAdd();
          else this.statusMessage = "Git references are not available here.";
          this.refresh();
        } else if (option === 2) {
          const editable = this.editableItems();
          if (editable.length === 0) {
            this.statusMessage = "No references configured yet.";
            this.refresh();
          } else {
            this.statusMessage = "";
            this.optionIndex = 0;
            this.step = { kind: "select-edit" };
            this.refresh();
          }
        } else if (option === 3) {
          this.startRemove();
        } else if (option === 4) {
          this.finish({ status: "saved", message: "References setup complete." });
        }
      }
      return;
    }
  }

  private startLocalAdd(): void {
    this.resetForm("local");
    this.step = { kind: "alias", form: "local" };
    this.refresh();
  }

  private startGitAdd(): void {
    this.resetForm("git");
    this.step = { kind: "alias", form: "git" };
    this.refresh();
  }

  private resetForm(form: "local" | "git"): void {
    this.form = form;
    this.alias = "";
    this.path = "";
    this.repository = "";
    this.branch = "";
    this.description = "";
    this.hidden = false;
    this.hiddenTouched = false;
    this.editAlias = null;
    this.statusMessage = "";
    this.editor.setText("");
  }

  private editableItems(): readonly ReferencesSetupItem[] {
    return this.items.filter((item) => item.local !== undefined || item.git !== undefined);
  }

  private startEdit(item: ReferencesSetupItem): void {
    const isGit = item.git !== undefined;
    this.form = isGit ? "git" : "local";
    this.editAlias = item.name;
    this.path = item.local?.path ?? "";
    this.repository = item.git?.repository ?? "";
    this.branch = item.git?.branch ?? "";
    this.description = (item.local?.description ?? item.git?.description) ?? "";
    this.hidden = (item.local?.hidden ?? item.git?.hidden) ?? false;
    this.hiddenTouched = false;
    this.optionIndex = 2; // Continue keeps raw hidden metadata unchanged.
    this.statusMessage = "";
    this.editor.setText(isGit ? this.repository : this.path);
    this.step = isGit ? { kind: "repository" } : { kind: "path" };
    this.refresh();
  }

  private retryFromResult(): void {
    if (!this.editing()) {
      this.editor.setText(this.alias);
      this.step = { kind: "alias", form: this.form };
      this.refresh();
      return;
    }
    if (this.form === "git") {
      this.editor.setText(this.repository);
      this.optionIndex = 2;
      this.step = { kind: "repository" };
    } else {
      this.editor.setText(this.path);
      this.optionIndex = 2;
      this.step = { kind: "path" };
    }
    this.refresh();
  }

  private startRemove(): void {
    const alias = this.items[this.optionIndex]?.name ?? "";
    this.step = { kind: "error", message: `Remove "${alias}" will be available in a later build.` };
    this.refresh();
  }

  private async submitForm(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.step = { kind: "busy", message: "Saving reference…" };
    this.refresh();
    const description = this.description || undefined;
    const hidden = this.hiddenTouched ? this.hidden : undefined;
    const result: ReferencesMutationResult = this.form === "git"
      ? this.editing()
        ? await this.controller.updateGit?.(this.editAlias!, this.gitInput()) ?? { ok: false, message: "Git editing is not available here." }
        : await this.controller.addGit?.({ alias: this.alias, ...this.gitInput() }) ?? { ok: false, message: "Git references are not available here." }
      : this.editing()
        ? await this.controller.updateLocal(this.editAlias!, this.localInput(description, hidden))
        : await this.controller.addLocal({ alias: this.alias, ...this.localInput(description, hidden) });
    if (this.settled) return;
    this.busy = false;
    if (result.ok) this.statusMessage = result.message;
    this.step = { kind: "result", ok: result.ok, message: result.message };
    this.optionIndex = 0;
    if (result.ok) void this.load();
    this.refresh();
  }

  private localInput(description?: string, hidden?: boolean): { path: string; description?: string; hidden?: boolean; signal?: AbortSignal } {
    const input: { path: string; description?: string; hidden?: boolean; signal?: AbortSignal } = { path: this.path };
    if (description !== undefined) input.description = description;
    if (hidden !== undefined) input.hidden = hidden;
    if (this.signal) input.signal = this.signal;
    return input;
  }

  private gitInput(): { repository: string; branch?: string; description?: string; hidden?: boolean; signal?: AbortSignal } {
    const input: { repository: string; branch?: string; description?: string; hidden?: boolean; signal?: AbortSignal } = { repository: this.repository };
    if (this.branch) input.branch = this.branch;
    else if (this.editing()) input.branch = ""; // explicit empty marker clears a stored branch
    if (this.description) input.description = this.description;
    if (this.description) input.description = this.description;
    if (this.hiddenTouched) input.hidden = this.hidden;
    if (this.signal) input.signal = this.signal;
    return input;
  }

  private async runOperation(name: string, refresh: boolean): Promise<void> {
    const operation = refresh ? this.controller.refreshGit : this.controller.testGit;
    if (!operation) {
      this.step = { kind: "result", ok: false, message: "Git operations are not available here." };
      this.refresh();
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.step = { kind: "busy", message: refresh ? "Refreshing reference…" : "Testing reference…" };
    this.refresh();
    const result = await operation(name, this.signal);
    if (this.settled) return;
    this.busy = false;
    this.step = { kind: "result", ok: result.ok, message: result.message };
    this.optionIndex = 0;
    this.refresh();
  }

  private returnToMenu(): void {
    this.editor.setText("");
    this.editAlias = null;
    this.hiddenTouched = false;
    this.form = "local";
    this.optionIndex = 0;
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