import type { Component } from "@earendil-works/pi-tui";
import { getModelGroups, saveModelGroups, type ModelGroup, deriveGroupContextWindow } from "@xzy-ai/runtime";

export interface ManageModelGroupsWizardOptions {
  theme?: unknown;
  onClose: () => void;
  modelRegistry?: { getAvailable(): Array<{ provider: string; id: string; contextWindow?: number }> };
}

export class ManageModelGroupsWizard implements Component {
  private groups: ModelGroup[];
  private activeGroupId?: string;
  private selected = 0;
  private onClose: () => void;
  private modelRegistry?: { getAvailable(): Array<{ provider: string; id: string; contextWindow?: number }> };
  constructor(options: ManageModelGroupsWizardOptions) {
    this.onClose = options.onClose;
    this.modelRegistry = options.modelRegistry;
    const file = getModelGroups();
    this.groups = file.groups;
    this.activeGroupId = file.activeGroupId;
  }
  invalidate(): void {}
  handleInput(data: string): boolean {
    if (data === "\u001b") { this.onClose(); return true; }
    if (data === "\r" || data === "\n") {
      const group = this.groups[this.selected];
      if (group) {
        saveModelGroups({ groups: this.groups, activeGroupId: group.id });
        this.activeGroupId = group.id;
      }
      return true;
    }
    if (data === "\u001b[A") { this.selected = Math.max(0, this.selected - 1); return true; }
    if (data === "\u001b[B") { this.selected = Math.min(this.groups.length - 1, this.selected + 1); return true; }
    return false;
  }
  render(width: number): string[] {
    const lines: string[] = [];
    lines.push("Model Groups (Enter to activate, Esc to close)");
    if (this.groups.length === 0) {
      lines.push("No groups configured");
      return lines;
    }
    for (let i = 0; i < this.groups.length; i++) {
      const g = this.groups[i]!;
      const isActive = g.id === this.activeGroupId;
      const prefix = i === this.selected ? "› " : "  ";
      const activeMark = isActive ? "● " : "○ ";
      let cw = "";
      if (this.modelRegistry) {
        const derived = deriveGroupContextWindow(g, this.modelRegistry.getAvailable());
        if (derived) cw = ` cw:${derived}`;
      }
      lines.push(`${prefix}${activeMark}${g.name} [${g.mode}] ${g.models.map((m)=>m.ref).join(", ")}${cw}`);
    }
    return lines;
  }
}
