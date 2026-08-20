import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";

export interface ModelGroupsWizardGroup {
  id: string;
  name: string;
  mode: string;
  quarantineMinutes: number;
  models: Array<{ ref: string; thinking?: string; reasoning?: boolean }>;
  contextWindow?: number;
}

export interface ManageModelGroupsWizardOptions {
  groups: ModelGroupsWizardGroup[];
  activeGroupId?: string;
  onActivate: (id: string) => void;
  onClose: () => void;
}

export class ManageModelGroupsWizard implements Component {
  private groups: ModelGroupsWizardGroup[];
  private activeGroupId?: string;
  private selected = 0;
  private onActivate: (id: string) => void;
  private onClose: () => void;
  constructor(options: ManageModelGroupsWizardOptions) {
    this.groups = options.groups;
    this.activeGroupId = options.activeGroupId;
    this.onActivate = options.onActivate;
    this.onClose = options.onClose;
  }
  invalidate(): void {}
  handleInput(data: string): boolean {
    if (matchesKey(data, Key.escape)) { this.onClose(); return true; }
    if (matchesKey(data, Key.enter)) {
      const group = this.groups[this.selected];
      if (group) {
        this.onActivate(group.id);
        this.activeGroupId = group.id;
      }
      return true;
    }
    if (matchesKey(data, Key.up)) { this.selected = Math.max(0, this.selected - 1); return true; }
    if (matchesKey(data, Key.down)) { this.selected = Math.min(this.groups.length - 1, this.selected + 1); return true; }
    return false;
  }
  render(_width: number): string[] {
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
      const cw = g.contextWindow ? ` cw:${g.contextWindow}` : "";
      lines.push(`${prefix}${activeMark}${g.name} [${g.mode}] ${g.models.map((m)=>m.ref).join(", ")}${cw}`);
    }
    return lines;
  }
}
