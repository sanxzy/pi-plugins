import { Input, Key, matchesKey, type Component, type TUI, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Maximum number of list items rendered at once; longer lists scroll. */
const MAX_VISIBLE_ITEMS = 10;

/** A model group as shown in the wizard, derived by the controller. */
export interface ManageModelGroupsGroupItem {
  readonly id: string;
  readonly name: string;
  readonly mode: "fallback" | "round-robin";
  readonly quarantineTurns: number;
  readonly contextWindow?: number;
  readonly models: ReadonlyArray<{
    readonly ref: string;
    readonly thinking?: string;
    readonly reasoning?: boolean;
    /** Remaining quarantine milliseconds at snapshot time; absent when healthy. */
    readonly quarantinedForTurns?: number;
  }>;
  readonly active: boolean;
}

/** A selectable model in the group model picker. */
export interface ManageModelGroupsModelItem {
  readonly provider: string;
  readonly id: string;
  /** Canonical `provider/id` reference. */
  readonly reference: string;
  /** Whether the model supports reasoning (drives the thinking picker). */
  readonly reasoning: boolean;
}

/** Outcome of applying a group mutation. */
export type ManageModelGroupsApplyResult =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly message: string };

/** Final wizard result, mirroring ManageAgentModelResult. */
export type ManageModelGroupsResult =
  | { readonly status: "saved"; readonly message: string }
  | { readonly status: "cancelled"; readonly message: string };

/** Expected group mutation payload. */
export interface ManageModelGroupsGroupInput {
  readonly name: string;
  readonly mode: "fallback" | "round-robin";
  readonly quarantineTurns: number;
  /** Optional group cap; blank means the minimum catalog window. */
  readonly contextWindow?: number;
  readonly models: ReadonlyArray<{ readonly ref: string; readonly thinking?: string }>;
}

/**
 * UI-agnostic boundary implemented by the commands package and driven by the
 * TUI wizard. Reads groups from the home-scoped `model-groups.json` store and
 * model/thinking references from the session's model registry.
 */
export interface ManageModelGroupsController {
  listGroups(): Promise<readonly ManageModelGroupsGroupItem[]>;
  listModels(): Promise<readonly ManageModelGroupsModelItem[]>;
  listThinkingLevels(modelReference: string): Promise<readonly { level: string; label: string }[]>;
  createGroup(input: ManageModelGroupsGroupInput): Promise<ManageModelGroupsApplyResult>;
  updateGroup(id: string, input: ManageModelGroupsGroupInput): Promise<ManageModelGroupsApplyResult>;
  deleteGroup(id: string): Promise<ManageModelGroupsApplyResult>;
}

export interface ManageModelGroupsWizardOptions {
  tui: TUI;
  theme: { fg: (color: string, text: string) => string };
  controller: ManageModelGroupsController;
  done: (result: ManageModelGroupsResult) => void;
  signal?: AbortSignal;
}

type Step =
  | { kind: "action" }
  | { kind: "createName" }
  | { kind: "createMode" }
  | { kind: "createQuarantine" }
  | { kind: "createContextWindow" }
  | { kind: "editName" }
  | { kind: "editMode" }
  | { kind: "editQuarantine" }
  | { kind: "editContextWindow" }
  | { kind: "addModel" }
  | { kind: "thinking" }
  | { kind: "modelMenu" }
  | { kind: "edit" }
  | { kind: "delete" }
  | { kind: "result" };

function scrollWindow(selectedIndex: number, total: number): { start: number; end: number } {
  if (total <= MAX_VISIBLE_ITEMS) return { start: 0, end: total };
  // Keep the selection in view; anchor at the start until it would overflow.
  const start = Math.max(0, Math.min(selectedIndex - MAX_VISIBLE_ITEMS + 1, total - MAX_VISIBLE_ITEMS));
  return { start, end: start + MAX_VISIBLE_ITEMS };
}

/**
 * Interactive model-group management wizard.
 *
 * Structure mirrors `ManageAgentModelWizard`: an action menu, `Input`-based
 * filtering for group/model lists, typed text steps for name and quarantine
 * minutes, and menu steps for mode/thinking. Every input repaints through
 * `tui.requestRender()` and Escape always steps back (or cancels at the top),
 * so the component never traps the user.
 */
export class ManageModelGroupsWizard implements Component {
  private readonly tui: TUI;
  private readonly theme: { fg: (color: string, text: string) => string };
  private readonly controller: ManageModelGroupsController;
  private readonly done: (result: ManageModelGroupsResult) => void;
  private readonly signal?: AbortSignal;
  private readonly search: Input;

  private step: Step = { kind: "action" };
  private actionIndex = 0;
  private modeIndex = 0;
  private groupIndex = 0;
  private modelIndex = 0;
  private thinkingIndex = 0;
  private modelMenuIndex = 0;
  private query = "";
  private groups: readonly ManageModelGroupsGroupItem[] = [];
  private models: readonly ManageModelGroupsModelItem[] = [];
  private thinkings: readonly { level: string; label: string }[] = [];
  private pendingName = "";
  private pendingMode: "fallback" | "round-robin" = "fallback";
  private pendingQuarantine = "5";
  private pendingContextWindow = "";
  private pendingModels: Array<{ ref: string; thinking?: string }> = [];
  private modelPickerBack: "createQuarantine" | "editQuarantine" | "modelMenu" = "modelMenu";
  private editingId?: string;
  private editingActive = false;
  private resultMessage = "";
  private cachedLines: string[] | undefined;
  private settled = false;
  private busy = false;

  constructor(options: ManageModelGroupsWizardOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.controller = options.controller;
    this.done = options.done;
    this.signal = options.signal;
    this.search = new Input();
    // The wizard intercepts Enter/Escape itself; these callbacks are never
    // reached because navigation keys are handled before the Input sees them.
    this.search.onSubmit = () => {};
    this.search.onEscape = () => {};
    if (options.signal) {
      options.signal.addEventListener("abort", this.cancel, { once: true });
      if (options.signal.aborted) void this.cancel();
    }
    void this.load();
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.search.invalidate();
  }

  private refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  private finish(result: ManageModelGroupsResult): void {
    if (this.settled) return;
    this.settled = true;
    this.done(result);
  }

  private async cancel(): Promise<void> {
    if (this.settled) return;
    this.finish({ status: "cancelled", message: "Model group management cancelled" });
  }

  private async load(): Promise<void> {
    try {
      const [groups, models] = await Promise.all([this.controller.listGroups(), this.controller.listModels()]);
      this.groups = groups;
      this.models = models;
    } catch {
      this.groups = [];
      this.models = [];
    }
    this.refresh();
  }

  private filteredGroups(): readonly ManageModelGroupsGroupItem[] {
    const q = this.query.trim().toLowerCase();
    if (!q) return this.groups;
    return this.groups.filter((group) => `${group.name} ${group.mode} ${group.models.map((m) => m.ref).join(" ")}`.toLowerCase().includes(q));
  }

  private filteredModels(): readonly ManageModelGroupsModelItem[] {
    const q = this.query.trim().toLowerCase();
    if (!q) return this.models;
    return this.models.filter((model) => `${model.reference}`.toLowerCase().includes(q));
  }

  private async runCreate(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const contextWindow = this.parseContextWindow();
      const result = await this.controller.createGroup({
        name: this.pendingName.trim(),
        mode: this.pendingMode,
        quarantineTurns: Number.parseInt(this.pendingQuarantine, 10),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        models: this.pendingModels,
      });
      if (result.ok) this.resultMessage = result.message;
      else this.resultMessage = result.message;
      await this.load();
      this.step = { kind: "result" };
    } finally {
      this.busy = false;
    }
    this.refresh();
  }

  private async runUpdate(): Promise<void> {
    if (this.busy || !this.editingId) return;
    this.busy = true;
    try {
      const contextWindow = this.parseContextWindow();
      const result = await this.controller.updateGroup(this.editingId, {
        name: this.pendingName.trim(),
        mode: this.pendingMode,
        quarantineTurns: Number.parseInt(this.pendingQuarantine, 10),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        models: this.pendingModels,
      });
      this.resultMessage = result.message;
      await this.load();
      this.step = { kind: "result" };
    } finally {
      this.busy = false;
    }
    this.refresh();
  }

  private async runDelete(id: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const result = await this.controller.deleteGroup(id);
      this.resultMessage = result.message;
      await this.load();
      this.step = { kind: "result" };
    } finally {
      this.busy = false;
    }
    this.refresh();
  }

  private async selectModel(model: ManageModelGroupsModelItem): Promise<void> {
    try {
      if (model.reasoning) {
        this.thinkings = await this.controller.listThinkingLevels(model.reference);
      } else {
        this.thinkings = [];
      }
    } catch {
      this.thinkings = [];
    }
    if (this.thinkings.length > 0) {
      this.pendingModels.push({ ref: model.reference });
      this.thinkingIndex = 0;
      this.step = { kind: "thinking" };
    } else {
      this.pendingModels.push({ ref: model.reference });
      this.step = { kind: "modelMenu" };
    }
    this.refresh();
  }

  private completeThinkingPick(): void {
    const level = this.thinkings[this.thinkingIndex]?.level;
    const last = this.pendingModels[this.pendingModels.length - 1];
    if (last && level) this.pendingModels[this.pendingModels.length - 1] = { ...last, thinking: level };
    this.modelMenuIndex = 0;
    this.step = { kind: "modelMenu" };
    this.refresh();
  }

  private parseContextWindow(): number | undefined {
    const value = this.pendingContextWindow.trim();
    if (value.length === 0) return undefined;
    const parsed = Number.parseInt(value, 10);
    // Preserve zero so the controller can reject it instead of treating it as
    // an omitted value; blank is the only input that means automatic minimum.
    return Number.isInteger(parsed) ? parsed : undefined;
  }

  private beginEdit(group: ManageModelGroupsGroupItem): void {
    this.editingId = group.id;
    this.editingActive = group.active;
    this.pendingName = group.name;
    this.pendingMode = group.mode;
    this.pendingQuarantine = String(group.quarantineTurns);
    this.pendingContextWindow = group.contextWindow === undefined ? "" : String(group.contextWindow);
    this.pendingModels = group.models.map((m) => ({ ref: m.ref, thinking: m.thinking }));
    this.search.setValue("");
    this.query = "";
    this.step = { kind: "editName" };
    this.refresh();
  }

  handleInput(data: string): void {
    if (this.settled || this.busy) return;
    if (this.step.kind === "action" || this.step.kind === "modelMenu") {
      const index = this.step.kind === "action" ? this.actionIndex : this.modelMenuIndex;
      const count = this.step.kind === "action" ? 4 : 5;
      const setIndex = (next: number): void => {
        if (this.step.kind === "action") this.actionIndex = next;
        else this.modelMenuIndex = next;
        this.refresh();
      };
      if (matchesKey(data, Key.up)) { setIndex(Math.max(0, index - 1)); return; }
      if (matchesKey(data, Key.down)) { setIndex(Math.min(count - 1, index + 1)); return; }
      if (matchesKey(data, Key.escape)) {
        if (this.step.kind === "modelMenu") {
          if (this.pendingModels.length > 0) this.pendingModels.pop();
          this.modelPickerBack = "modelMenu";
          this.step = { kind: "addModel" };
        } else {
          void this.cancel();
        }
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        if (this.step.kind === "action") {
          this.enterAction(index);
        } else {
          this.enterModelMenu(index);
        }
        return;
      }
      return;
    }
    if (this.step.kind === "result") {
      if (matchesKey(data, Key.enter)) {
        this.finish({ status: "saved", message: this.resultMessage });
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.finish({ status: "cancelled", message: this.resultMessage });
        return;
      }
      return;
    }
    if (this.step.kind === "addModel") {
      if (matchesKey(data, Key.up)) { this.modelIndex = Math.max(0, this.modelIndex - 1); this.refresh(); return; }
      if (matchesKey(data, Key.down)) { this.modelIndex = Math.min(this.filteredModels().length - 1, this.modelIndex + 1); this.refresh(); return; }
      if (matchesKey(data, Key.escape)) {
        this.step = { kind: this.modelPickerBack };
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const filtered = this.filteredModels();
        const model = filtered[this.modelIndex];
        if (model) void this.selectModel(model);
        return;
      }
      this.search.handleInput(data);
      this.query = this.search.getValue();
      this.modelIndex = 0;
      this.refresh();
      return;
    }
    if (this.step.kind === "thinking") {
      if (matchesKey(data, Key.up)) { this.thinkingIndex = Math.max(0, this.thinkingIndex - 1); this.refresh(); return; }
      if (matchesKey(data, Key.down)) { this.thinkingIndex = Math.min(this.thinkings.length - 1, this.thinkingIndex + 1); this.refresh(); return; }
      if (matchesKey(data, Key.escape)) { this.step = { kind: "modelMenu" }; this.refresh(); return; }
      if (matchesKey(data, Key.enter)) { this.completeThinkingPick(); return; }
      return;
    }
    // Typed-input steps (name, quarantine, context window) route raw text into their field.
    if (this.step.kind === "createName" || this.step.kind === "editName" || this.step.kind === "createQuarantine" || this.step.kind === "editQuarantine" || this.step.kind === "createContextWindow" || this.step.kind === "editContextWindow") {
      if (matchesKey(data, Key.escape)) {
        if (this.step.kind === "editName") {
          // Back to the group picker; the in-progress edit is discarded.
          this.step = { kind: "edit" };
        } else if (this.step.kind === "editContextWindow" || this.step.kind === "createContextWindow") {
          this.step = { kind: "modelMenu" };
        } else {
          this.step = { kind: this.editingId ? "editName" : "action" };
        }
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.advanceTyped();
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        const field = this.step.kind === "createName" || this.step.kind === "editName" ? "name" : this.step.kind === "createContextWindow" || this.step.kind === "editContextWindow" ? "contextWindow" : "quarantine";
        if (field === "name") this.pendingName = this.pendingName.slice(0, -1);
        else if (field === "contextWindow") this.pendingContextWindow = this.pendingContextWindow.slice(0, -1);
        else this.pendingQuarantine = this.pendingQuarantine.slice(0, -1);
        this.refresh();
        return;
      }
      if (typeof data === "string" && data.length === 1 && !/[\x00-\x1f]/.test(data)) {
        const field = this.step.kind === "createName" || this.step.kind === "editName" ? "name" : this.step.kind === "createContextWindow" || this.step.kind === "editContextWindow" ? "contextWindow" : "quarantine";
        if (field === "name") this.pendingName += data;
        else if (field === "contextWindow" && /[0-9]/.test(data)) this.pendingContextWindow += data;
        else if (field === "quarantine" && /[0-9]/.test(data)) this.pendingQuarantine += data;
        this.refresh();
        return;
      }
      return;
    }
    if (this.step.kind === "createMode" || this.step.kind === "editMode") {
      if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) { this.modeIndex = this.modeIndex === 0 ? 1 : 0; this.refresh(); return; }
      if (matchesKey(data, Key.escape)) { this.step = { kind: this.editingId ? "editName" : "createName" }; this.refresh(); return; }
      if (matchesKey(data, Key.enter)) {
        this.pendingMode = this.modeIndex === 0 ? "fallback" : "round-robin";
        this.step = { kind: this.editingId ? "editQuarantine" : "createQuarantine" };
        this.refresh();
      }
      return;
    }
    // Group selection lists.
    if (matchesKey(data, Key.up)) { this.groupIndex = Math.max(0, this.groupIndex - 1); this.refresh(); return; }
    if (matchesKey(data, Key.down)) { this.groupIndex = Math.min(this.filteredGroups().length - 1, this.groupIndex + 1); this.refresh(); return; }
    if (matchesKey(data, Key.escape)) {
      this.step = { kind: "action" };
      this.search.setValue("");
      this.query = "";
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const filtered = this.filteredGroups();
      const group = filtered[this.groupIndex];
      if (!group) return;
      if (this.step.kind === "delete") { void this.runDelete(group.id); return; }
      if (this.step.kind === "edit") { this.beginEdit(group); return; }
      return;
    }
    this.search.handleInput(data);
    this.query = this.search.getValue();
    this.groupIndex = 0;
    this.refresh();
  }

  private advanceTyped(): void {
    if (this.step.kind === "createName") { this.step = { kind: "createMode" }; this.modeIndex = this.pendingMode === "fallback" ? 0 : 1; this.refresh(); return; }
    if (this.step.kind === "editName") { this.step = { kind: "editMode" }; this.modeIndex = this.pendingMode === "fallback" ? 0 : 1; this.refresh(); return; }
    if (this.step.kind === "createQuarantine" || this.step.kind === "editQuarantine") {
      this.search.setValue("");
      this.query = "";
      this.modelIndex = 0;
      this.pendingModels = this.editingId ? this.pendingModels.slice() : [];
      this.modelPickerBack = this.editingId ? "editQuarantine" : "createQuarantine";
      this.step = { kind: "addModel" };
      this.refresh();
      return;
    }
    if (this.step.kind === "createContextWindow" || this.step.kind === "editContextWindow") {
      if (this.editingId) void this.runUpdate();
      else void this.runCreate();
      return;
    }
  }

  private enterAction(index: number): void {
    if (index === 0) { this.pendingName = ""; this.pendingMode = "fallback"; this.pendingQuarantine = "5"; this.pendingContextWindow = ""; this.pendingModels = []; this.editingId = undefined; this.modelPickerBack = "createQuarantine"; this.step = { kind: "createName" }; this.refresh(); return; }
    if (index === 1) { this.search.setValue(""); this.query = ""; this.groupIndex = 0; this.step = { kind: "edit" }; this.refresh(); return; }
    if (index === 2) { this.search.setValue(""); this.query = ""; this.groupIndex = 0; this.step = { kind: "delete" }; this.refresh(); return; }
    this.finish({ status: "saved", message: "Done." });
  }

  private enterModelMenu(index: number): void {
    // 0: add another model, 1: remove last model, 2: move last up, 3: save, 4: cancel editing
    if (index === 0) { this.search.setValue(""); this.query = ""; this.modelIndex = 0; this.modelPickerBack = "modelMenu"; this.step = { kind: "addModel" }; this.refresh(); return; }
    if (index === 1) {
      if (this.pendingModels.length > 0) this.pendingModels.pop();
      this.refresh();
      return;
    }
    if (index === 2) {
      if (this.pendingModels.length > 1) {
        const last = this.pendingModels[this.pendingModels.length - 1]!;
        this.pendingModels[this.pendingModels.length - 1] = this.pendingModels[this.pendingModels.length - 2]!;
        this.pendingModels[this.pendingModels.length - 2] = last;
      }
      this.refresh();
      return;
    }
    if (index === 3) {
      this.step = { kind: this.editingId ? "editContextWindow" : "createContextWindow" };
      this.refresh();
      return;
    }
    // Cancel editing → back to action menu.
    this.editingId = undefined;
    this.pendingModels = [];
    this.step = { kind: "action" };
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
    const selected = (flag: boolean): string => (flag ? this.theme.fg("accent", "> ") : "  ");
    lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));
    switch (this.step.kind) {
      case "action": {
        add(" ", this.theme.fg("accent", "Manage model groups"));
        const options = ["Create group", "Edit group", "Delete group", "Done"];
        for (let i = 0; i < options.length; i++) {
          add(selected(i === this.actionIndex), this.theme.fg(i === this.actionIndex ? "accent" : "text", `${i + 1}. ${options[i]}`));
        }
        add(" ", this.theme.fg("dim", "↑↓ navigate • Enter select • Esc cancel"));
        break;
      }
      case "edit":
      case "delete": {
        const heading = this.step.kind === "edit" ? "edit" : "delete";
        add(" ", this.theme.fg("accent", `Manage model groups · ${heading} group`));
        add(" ", this.theme.fg("muted", "Type to filter • ↑↓ navigate • Enter select • Esc back"));
        add(" ", this.theme.fg("text", `Filter: ${this.search.getValue()}`));
        const filtered = this.filteredGroups();
        if (filtered.length === 0) {
          add(" ", this.theme.fg("muted", "No groups match."));
        } else {
          const window = scrollWindow(Math.min(this.groupIndex, filtered.length - 1), filtered.length);
          for (let i = window.start; i < window.end; i++) {
            const group = filtered[i]!;
            const flag = i === this.groupIndex;
            const activeTag = group.active ? " ●" : "";
            const memberTag = (ref: string, thinking?: string): string => (thinking ? `${ref}·${thinking}` : ref);
            const modelsTag = group.models
              .map((m) => memberTag(m.ref, m.thinking) + (m.quarantinedForTurns !== undefined ? ` ⏳${m.quarantinedForTurns}t` : ""))
              .join(", ");
            add(selected(flag), this.theme.fg(flag ? "accent" : "text", `${i + 1}. ${group.name} [${group.mode}] q${group.quarantineTurns}t cw:${group.contextWindow ?? "?"}${activeTag} · ${modelsTag}`));
          }
          if (filtered.length > MAX_VISIBLE_ITEMS) {
            add(" ", this.theme.fg("dim", `${window.start + 1}–${Math.min(window.end, filtered.length)} of ${filtered.length}`));
          }
        }
        break;
      }
      case "createName":
      case "editName": {
        add(" ", this.theme.fg("accent", this.step.kind === "createName" ? "Create group · name" : `Edit group · name`));
        add(" ", this.theme.fg("text", `Name: ${this.pendingName}▌`));
        add(" ", this.theme.fg("dim", "Type the group name • Enter next • Esc back"));
        break;
      }
      case "createMode":
      case "editMode": {
        add(" ", this.theme.fg("accent", "Group mode"));
        for (let i = 0; i < 2; i++) {
          const modeName = i === 0 ? "fallback" : "round-robin";
          add(selected(i === this.modeIndex), this.theme.fg(i === this.modeIndex ? "accent" : "text", `${i + 1}. ${modeName}`));
        }
        add(" ", this.theme.fg("dim", "fallback: first healthy model, next on 4xx/5xx • round-robin: rotate per turn"));
        break;
      }
      case "createQuarantine":
      case "editQuarantine": {
        add(" ", this.theme.fg("accent", "Quarantine turns (1-100)"));
        add(" ", this.theme.fg("text", `Minutes: ${this.pendingQuarantine}▌`));
        add(" ", this.theme.fg("dim", "Type a number • Enter next • Esc back"));
        break;
      }
      case "createContextWindow":
      case "editContextWindow": {
        add(" ", this.theme.fg("accent", "Group context window"));
        add(" ", this.theme.fg("text", `Tokens: ${this.pendingContextWindow || "auto/minimum"}▌`));
        add(" ", this.theme.fg("dim", "Set after selecting models • blank uses the minimum member window • Enter save • Esc back"));
        break;
      }
      case "addModel": {
        add(" ", this.theme.fg("accent", "Add model to group"));
        add(" ", this.theme.fg("muted", "Type to filter • ↑↓ navigate • Enter add • Esc back"));
        add(" ", this.theme.fg("text", `Filter: ${this.search.getValue()}`));
        const filtered = this.filteredModels();
        if (filtered.length === 0) {
          add(" ", this.theme.fg("muted", "No models match."));
        } else {
          const window = scrollWindow(Math.min(this.modelIndex, filtered.length - 1), filtered.length);
          for (let i = window.start; i < window.end; i++) {
            const model = filtered[i]!;
            const flag = i === this.modelIndex;
            add(selected(flag), this.theme.fg(flag ? "accent" : "text", `${i + 1}. ${model.reference}`));
          }
          if (filtered.length > MAX_VISIBLE_ITEMS) {
            add(" ", this.theme.fg("dim", `${window.start + 1}–${Math.min(window.end, filtered.length)} of ${filtered.length}`));
          }
        }
        break;
      }
      case "thinking": {
        add(" ", this.theme.fg("accent", "Thinking level for this model"));
        for (let i = 0; i < this.thinkings.length; i++) {
          const level = this.thinkings[i]!;
          add(selected(i === this.thinkingIndex), this.theme.fg(i === this.thinkingIndex ? "accent" : "text", `${i + 1}. ${level.label}`));
        }
        add(" ", this.theme.fg("dim", "↑↓ navigate • Enter select • Esc back"));
        break;
      }
      case "modelMenu": {
        add(" ", this.theme.fg("accent", `Group models (${this.pendingModels.map((m) => m.ref).join(", ") || "none"})`));
        const options = ["Add another model", "Remove last model", "Move last model up", "Save group", "Cancel editing"];
        for (let i = 0; i < options.length; i++) {
          add(selected(i === this.modelMenuIndex), this.theme.fg(i === this.modelMenuIndex ? "accent" : "text", `${i + 1}. ${options[i]}`));
        }
        break;
      }
      case "result": {
        add(" ", this.theme.fg("accent", "Model groups"));
        add(" ", this.theme.fg("text", this.resultMessage || "Done."));
        const active = this.groups.find((g) => g.active);
        if (active) {
          add(" ", this.theme.fg("dim", `Active group: ${active.name}`));
        }
        add(" ", this.theme.fg("dim", "Enter finish • Esc cancel"));
        break;
      }
    }
    lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));
    this.cachedLines = lines;
    return lines;
  }
}