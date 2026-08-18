import { Input, Key, matchesKey, type Component, type TUI, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Maximum number of list items rendered at once; longer lists scroll. */
const MAX_VISIBLE_ITEMS = 10;

/** An agent selectable in the wizard. */
export interface ManageAgentModelAgentItem {
  readonly name: string;
  readonly description: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly filePath: string;
}

/** A model selectable in the wizard, formatted as the `/model` reference. */
export interface ManageAgentModelModelItem {
  readonly provider: string;
  readonly id: string;
  /** The exact model reference string written to frontmatter (`provider/id`). */
  readonly reference: string;
}

/** A thinking level selectable in the wizard. */
export interface ManageAgentModelThinkingItem {
  readonly level: string;
  readonly label: string;
}

/** Outcome of applying a set/remove operation. */
export type ManageAgentModelApplyResult =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly message: string };

/** UI-agnostic boundary implemented by the commands package. */
export interface ManageAgentModelController {
  /** Every discovered agent (user + project, project overrides). */
  listAgents(): Promise<readonly ManageAgentModelAgentItem[]>;
  /** Every available model, formatted like `/model`. */
  listModels(): Promise<readonly ManageAgentModelModelItem[]>;
  /** The thinking levels the given model reference supports (empty when only `off`). */
  listThinkingLevels(modelReference: string): Promise<readonly ManageAgentModelThinkingItem[]>;
  /** Write `model: <reference>` (+ optional `thinking`) into the agent file's frontmatter. */
  setModel(agentName: string, reference: string, thinking?: string, signal?: AbortSignal): Promise<ManageAgentModelApplyResult>;
  /** Remove the `model`/`thinking` keys from the agent file's frontmatter. */
  removeModel(agentName: string, signal?: AbortSignal): Promise<ManageAgentModelApplyResult>;
  /** The current global agent model + thinking (home-root `pi-c2/config.json` `agents.model`/`agents.thinking`) and its config file path. */
  getGlobalModel(): Promise<{ model?: string; thinking?: string; configPath: string }>;
  /** Set the global agent model (+ optional thinking) in the home-root `pi-c2/config.json`, exactly as given. */
  setGlobalModel(reference: string, thinking?: string, signal?: AbortSignal): Promise<ManageAgentModelApplyResult>;
  /** Remove the global agent model + thinking keys from the home-root `pi-c2/config.json`. */
  removeGlobalModel(signal?: AbortSignal): Promise<ManageAgentModelApplyResult>;
  cancel(): Promise<void>;
}

/** Wizard flow: pick an action, then the agent, then (for set) the model and thinking level. */
type WizardStep =
  | { kind: "action" }
  | { kind: "agent" }
  | { kind: "model" }
  | { kind: "thinking" }
  | { kind: "global" }
  | { kind: "busy"; message: string }
  | { kind: "result"; ok: boolean; message: string };

export type ManageAgentModelResult =
  | { readonly status: "saved"; readonly message: string }
  | { readonly status: "cancelled" }
  | { readonly status: "error"; readonly message: string };

export interface ManageAgentModelWizardOptions {
  tui: TUI;
  theme: { fg: (color: string, text: string) => string };
  controller: ManageAgentModelController;
  done: (result: ManageAgentModelResult) => void;
  signal?: AbortSignal;
}

interface SelectableModel extends ManageAgentModelModelItem {
  label: string;
}

/** The slice of a list to render so the selected index stays visible. */
function scrollWindow(selectedIndex: number, total: number): { start: number; end: number } {
  if (total <= MAX_VISIBLE_ITEMS) return { start: 0, end: total };
  // Keep the selection in view; anchor at the start until it would overflow.
  const start = Math.max(0, Math.min(selectedIndex - MAX_VISIBLE_ITEMS + 1, total - MAX_VISIBLE_ITEMS));
  return { start, end: start + MAX_VISIBLE_ITEMS };
}

export class ManageAgentModelWizard implements Component {
  private readonly tui: TUI;
  private readonly theme: NonNullable<ManageAgentModelWizardOptions["theme"]>;
  private readonly controller: ManageAgentModelController;
  private readonly done: (result: ManageAgentModelResult) => void;
  private readonly signal?: AbortSignal;
  private readonly search: Input;

  private step: WizardStep = { kind: "action" };
  private actionIndex = 0;
  private globalActionIndex = 0;
  private agentIndex = 0;
  private modelIndex = 0;
  private thinkingIndex = 0;
  private query = "";
  private agents: readonly ManageAgentModelAgentItem[] = [];
  private models: readonly SelectableModel[] = [];
  private thinkings: readonly ManageAgentModelThinkingItem[] = [];
  private selectedAgent: ManageAgentModelAgentItem | undefined;
  private selectedModel: SelectableModel | undefined;
  private globalModel?: string;
  private globalThinking?: string;
  private globalConfigPath?: string;
  private cachedLines: string[] | undefined;
  private settled = false;
  private busy = false;

  constructor(options: ManageAgentModelWizardOptions) {
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

  private async load(): Promise<void> {
    try {
      const [agents, models, global] = await Promise.all([
        this.controller.listAgents(),
        this.controller.listModels(),
        this.controller.getGlobalModel(),
      ]);
      this.agents = agents;
      this.models = models.map((model) => ({ ...model, label: model.reference }));
      this.globalModel = global.model;
      this.globalThinking = global.thinking;
      this.globalConfigPath = global.configPath;
    } catch {
      this.agents = [];
      this.models = [];
      this.globalModel = undefined;
      this.globalThinking = undefined;
      this.globalConfigPath = undefined;
    }
    this.refresh();
  }

  private filteredAgents(): readonly ManageAgentModelAgentItem[] {
    const q = this.query.trim().toLowerCase();
    if (!q) return this.agents;
    return this.agents.filter((agent) => `${agent.name} ${agent.description} ${agent.model ?? ""}`.toLowerCase().includes(q));
  }

  private filteredModels(): readonly SelectableModel[] {
    const q = this.query.trim().toLowerCase();
    if (!q) return this.models;
    return this.models.filter((model) => model.label.toLowerCase().includes(q));
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
      case "action": {
        add(" ", this.theme.fg("accent", "Manage agent model"));
        const options = [
          "Set / replace agent model",
          "Remove agent model",
          "Set / replace global agent model",
          "Remove global agent model",
          "Done",
        ];
        for (let i = 0; i < options.length; i++) {
          const selected = i === this.actionIndex;
          add(selected ? this.theme.fg("accent", "> ") : "  ", this.theme.fg(selected ? "accent" : "text", `${i + 1}. ${options[i]}`));
        }
        if (this.globalModel) {
          add(" ", this.theme.fg("dim", `Global agent model: ${this.globalModel}${this.globalThinking ? ` · thinking ${this.globalThinking}` : ""}`));
        }
        add(" ", this.theme.fg("dim", "↑↓ navigate • Enter select • Esc cancel"));
        break;
      }
      case "agent": {
        add(" ", this.theme.fg("accent", "Manage agent model · select agent"));
        add(" ", this.theme.fg("muted", this.step.kind === "agent" ? "Type to filter • ↑↓ navigate • Enter select • Esc back" : ""));
        add(" ", this.theme.fg("text", `Filter: ${this.search.getValue()}`));
        const filtered = this.filteredAgents();
        if (filtered.length === 0) {
          add(" ", this.theme.fg("muted", "No agents match."));
        } else {
          const window = scrollWindow(this.agentIndex, filtered.length);
          for (let i = window.start; i < window.end; i++) {
            const agent = filtered[i]!;
            const selected = i === this.agentIndex;
            const modelTag = agent.model ? ` · model: ${agent.model}` : "";
            add(selected ? this.theme.fg("accent", "> ") : "  ", this.theme.fg(selected ? "accent" : "text", `${i + 1}. ${agent.name}${modelTag}`));
          }
          if (filtered.length > MAX_VISIBLE_ITEMS) {
            add(" ", this.theme.fg("dim", `${window.start + 1}–${window.end} of ${filtered.length}`));
          }
        }
        break;
      }
      case "model": {
        const contextLabel = this.actionIndex === 2 ? "global agent model" : (this.selectedAgent?.name ?? "");
        add(" ", this.theme.fg("accent", `Manage agent model · ${contextLabel} · select model`));
        add(" ", this.theme.fg("muted", "Type to filter • ↑↓ navigate • Enter select • Esc back"));
        add(" ", this.theme.fg("text", `Filter: ${this.search.getValue()}`));
        const filtered = this.filteredModels();
        if (filtered.length === 0) {
          add(" ", this.theme.fg("muted", "No models match."));
        } else {
          const window = scrollWindow(this.modelIndex, filtered.length);
          for (let i = window.start; i < window.end; i++) {
            const model = filtered[i]!;
            const selected = i === this.modelIndex;
            add(selected ? this.theme.fg("accent", "> ") : "  ", this.theme.fg(selected ? "accent" : "text", `${i + 1}. ${model.label}`));
          }
          if (filtered.length > MAX_VISIBLE_ITEMS) {
            add(" ", this.theme.fg("dim", `${window.start + 1}–${window.end} of ${filtered.length}`));
          }
        }
        add(" ", this.theme.fg("dim", "↑↓ navigate • Enter select • Esc back"));
        break;
      }
      case "thinking": {
        const contextLabel = this.actionIndex === 2 ? "global agent model" : (this.selectedAgent?.name ?? "");
        add(" ", this.theme.fg("accent", `Manage agent model · ${contextLabel} · ${this.selectedModel?.label ?? ""} · thinking level`));
        if (this.thinkings.length === 0) {
          add(" ", this.theme.fg("muted", "This model does not support thinking levels."));
          add(" ", this.theme.fg("dim", "Enter continue"));
        } else {
          const window = scrollWindow(this.thinkingIndex, this.thinkings.length);
          for (let i = window.start; i < window.end; i++) {
            const item = this.thinkings[i]!;
            const selected = i === this.thinkingIndex;
            add(selected ? this.theme.fg("accent", "> ") : "  ", this.theme.fg(selected ? "accent" : "text", `${i + 1}. ${item.label}`));
          }
          add(" ", this.theme.fg("dim", "↑↓ navigate • Enter select • Esc back"));
        }
        break;
      }
      case "global": {
        add(" ", this.theme.fg("accent", "Manage agent model · global agent model"));
        if (this.globalModel) {
          add(" ", this.theme.fg("text", `Current: ${this.globalModel}${this.globalThinking ? ` · thinking ${this.globalThinking}` : ""}`));
        } else {
          add(" ", this.theme.fg("muted", "No global agent model is configured. Agents without a frontmatter model inherit the parent model."));
        }
        add(" ", this.theme.fg("dim", `Config: ${this.globalConfigPath ?? "unknown"}`));
        const options = [
          "Set / replace global agent model",
          "Remove global agent model",
          "Back",
        ];
        for (let i = 0; i < options.length; i++) {
          const selected = i === this.globalActionIndex;
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
    }
    lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.search.invalidate();
  }

  handleInput(data: string): void {
    if (this.settled || this.busy) return;
    if (this.step.kind === "action") {
      if (matchesKey(data, Key.up)) {
        this.actionIndex = Math.max(0, this.actionIndex - 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.actionIndex = Math.min(4, this.actionIndex + 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.escape)) {
        void this.cancel();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        if (this.actionIndex === 0 || this.actionIndex === 1) {
          this.startAgentStep();
        } else if (this.actionIndex === 2 || this.actionIndex === 3) {
          this.globalActionIndex = 0;
          this.step = { kind: "global" };
          this.refresh();
        } else {
          this.finish({ status: "saved", message: "Done." });
        }
      }
      return;
    }
    if (this.step.kind === "global") {
      if (matchesKey(data, Key.up)) {
        this.globalActionIndex = Math.max(0, this.globalActionIndex - 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.globalActionIndex = Math.min(2, this.globalActionIndex + 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        if (this.globalActionIndex === 0) {
          this.search.setValue("");
          this.query = "";
          this.modelIndex = 0;
          this.step = { kind: "model" };
          this.refresh();
        } else if (this.globalActionIndex === 1) {
          void this.runRemoveGlobal();
        } else {
          this.step = { kind: "action" };
          this.refresh();
        }
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.step = { kind: "action" };
        this.refresh();
        return;
      }
      return;
    }
    if (this.step.kind === "agent") {
      const filtered = this.filteredAgents();
      if (matchesKey(data, Key.up)) {
        this.agentIndex = Math.max(0, this.agentIndex - 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.agentIndex = Math.min(filtered.length - 1, this.agentIndex + 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const agent = filtered[this.agentIndex];
        if (agent) {
          this.selectedAgent = agent;
          this.agentIndex = 0;
          if (this.actionIndex === 0) {
            this.search.setValue("");
            this.query = "";
            this.modelIndex = 0;
            this.step = { kind: "model" };
          } else {
            void this.runRemove(agent.name);
          }
          this.refresh();
        }
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.actionIndex = 0;
        this.step = { kind: "action" };
        this.refresh();
        return;
      }
      this.handleSearchInput(data);
      return;
    }
    if (this.step.kind === "model") {
      const filtered = this.filteredModels();
      if (matchesKey(data, Key.up)) {
        this.modelIndex = Math.max(0, this.modelIndex - 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.modelIndex = Math.min(filtered.length - 1, this.modelIndex + 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const model = filtered[this.modelIndex];
        if (model && this.selectedAgent) {
          this.selectedModel = model;
          this.modelIndex = 0;
          void this.startThinkingStep(this.selectedAgent.name, model.reference);
        } else if (model && this.actionIndex === 2) {
          this.selectedModel = model;
          this.modelIndex = 0;
          void this.startGlobalThinkingStep(model.reference);
        }
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.step = this.actionIndex === 2 ? { kind: "global" } : { kind: "agent" };
        this.refresh();
        return;
      }
      this.handleSearchInput(data);
      return;
    }
    if (this.step.kind === "thinking") {
      if (matchesKey(data, Key.up)) {
        this.thinkingIndex = Math.max(0, this.thinkingIndex - 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.thinkingIndex = Math.min(this.thinkings.length - 1, this.thinkingIndex + 1);
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const thinking = this.thinkings[this.thinkingIndex];
        if (this.actionIndex === 2 && this.selectedModel) {
          void this.runSetGlobal(this.selectedModel.reference, thinking?.level);
        } else if (this.selectedAgent && this.selectedModel) {
          void this.runSet(this.selectedAgent.name, this.selectedModel.reference, thinking?.level);
        }
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.step = { kind: "model" };
        this.refresh();
        return;
      }
      return;
    }
    if (this.step.kind === "result") {
      if (matchesKey(data, Key.enter)) {
        this.finish({ status: "saved", message: this.step.message });
      } else if (matchesKey(data, Key.escape)) {
        void this.cancel();
      }
      return;
    }
  }

  private handleSearchInput(data: string): void {
    const before = this.search.getValue();
    this.search.handleInput(data);
    const after = this.search.getValue();
    if (after !== before) {
      this.query = after;
      this.agentIndex = 0;
      this.modelIndex = 0;
      this.refresh();
    }
  }

  private startAgentStep(): void {
    if (this.agents.length === 0) {
      this.step = { kind: "result", ok: false, message: "No agents are defined. Add an agent file under .pi/agents, .claude/agents, or .agents/agents." };
      this.refresh();
      return;
    }
    this.search.setValue("");
    this.query = "";
    this.agentIndex = 0;
    this.step = { kind: "agent" };
    this.refresh();
  }

  private startThinkingStep(name: string, reference: string): void {
    void (async () => {
      this.step = { kind: "busy", message: "Checking thinking support…" };
      this.refresh();
      let levels: readonly ManageAgentModelThinkingItem[];
      try {
        levels = await this.controller.listThinkingLevels(reference);
      } catch {
        levels = [];
      }
      if (this.settled) return;
      this.thinkings = levels;
      this.thinkingIndex = 0;
      this.step = { kind: "thinking" };
      this.refresh();
    })();
  }

  /** Global set: check thinking support, then route to the shared thinking step (or apply directly when only `off`). */
  private startGlobalThinkingStep(reference: string): void {
    void (async () => {
      this.step = { kind: "busy", message: "Checking thinking support…" };
      this.refresh();
      let levels: readonly ManageAgentModelThinkingItem[];
      try {
        levels = await this.controller.listThinkingLevels(reference);
      } catch {
        levels = [];
      }
      if (this.settled) return;
      // Non-reasoning models expose only `off`; apply directly without a picker.
      if (levels.length <= 1 && levels[0]?.level === "off") {
        void this.runSetGlobal(reference);
        return;
      }
      this.thinkings = levels;
      this.thinkingIndex = 0;
      this.step = { kind: "thinking" };
      this.refresh();
    })();
  }

  private async runSet(name: string, reference: string, thinking?: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.step = { kind: "busy", message: `Setting ${name} model to ${reference}…` };
    this.refresh();
    const result = await this.controller.setModel(name, reference, thinking, this.signal);
    if (this.settled) return;
    this.busy = false;
    this.step = { kind: "result", ok: result.ok, message: result.message };
    this.refresh();
  }

  private async runRemove(name: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.step = { kind: "busy", message: `Removing ${name} model…` };
    this.refresh();
    const result = await this.controller.removeModel(name, this.signal);
    if (this.settled) return;
    this.busy = false;
    this.step = { kind: "result", ok: result.ok, message: result.message };
    this.refresh();
  }

  private async runSetGlobal(reference: string, thinking?: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.step = { kind: "busy", message: `Setting global agent model to ${reference}${thinking ? `, thinking ${thinking}` : ""}…` };
    this.refresh();
    const result = await this.controller.setGlobalModel(reference, thinking, this.signal);
    if (this.settled) return;
    this.busy = false;
    this.globalModel = result.ok ? reference : this.globalModel;
    this.globalThinking = result.ok ? thinking : this.globalThinking;
    this.step = { kind: "result", ok: result.ok, message: result.message };
    this.refresh();
  }

  private async runRemoveGlobal(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.step = { kind: "busy", message: "Removing global agent model…" };
    this.refresh();
    const result = await this.controller.removeGlobalModel(this.signal);
    if (this.settled) return;
    this.busy = false;
    if (result.ok) {
      this.globalModel = undefined;
      this.globalThinking = undefined;
    }
    this.step = { kind: "result", ok: result.ok, message: result.message };
    this.refresh();
  }

  private readonly cancel = async (): Promise<void> => {
    if (this.settled) return;
    this.settled = true;
    await this.controller.cancel();
    this.done({ status: "cancelled" });
  };

  private finish(result: ManageAgentModelResult): void {
    if (this.settled) return;
    this.settled = true;
    this.done(result);
  }

  private refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }
}
