import { relative, resolve, sep, isAbsolute } from "node:path";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

/** Theme surface required by the host-owned footer component. */
export interface AgentFooterTheme {
  fg: (color: string, text: string) => string;
}

/** Public host data projected into the native-information footer rows. */
export interface AgentFooterInfo {
  readonly cwd: string;
  readonly home?: string;
  readonly branch: string | null;
  readonly sessionName?: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cacheHitRate?: number;
  readonly cost: number;
  readonly contextPercent: number | null;
  readonly contextWindow: number;
  readonly autoCompactEnabled: boolean;
  readonly model?: string;
  readonly provider?: string;
  readonly providerCount: number;
  readonly thinkingLevel?: string;
  readonly reasoning: boolean;
}

export type FooterTreeStatus =
  | "active"
  | "created"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/** Live per-agent stats projected by the host while a child session is running. */
export interface FooterTreeLiveStats {
  /** Agent definition name (subagent type) that runs the job. */
  readonly subagentType: string;
  /** Tool executions observed so far. */
  readonly toolUses: number;
  /** Total tokens reported by the session so far (input + output + cache). */
  readonly tokens: number;
}

/** One projected descendant row rendered below the native information rows. */
export interface FooterTreeRow {
  readonly rowId: string;
  /** True for the host session row that anchors a non-empty descendant tree. */
  readonly root?: boolean;
  readonly status: FooterTreeStatus;
  readonly depth: number;
  readonly description: string;
  readonly durationMs: number;
  readonly leaf?: string;
  /** Live counters shown in the compact running-agent line when present. */
  readonly live?: FooterTreeLiveStats;
  /** Agent type label when available before the agent is running. */
  readonly subagentType?: string;
  readonly enterable: boolean;
  readonly updatedAt?: string;
  /** Test and adapter seam when the caller already has a settled timestamp. */
  readonly updatedAtMs?: number;
}

export interface AgentFooterOptions {
  readonly tui: TUI;
  readonly theme: AgentFooterTheme;
  readonly getInfo: () => AgentFooterInfo;
  readonly getRows?: () => readonly FooterTreeRow[];
  readonly onEnter?: (row: FooterTreeRow | undefined) => void;
  readonly dispose?: () => void;
}

const MAX_VISIBLE_MANAGEMENT_ROWS = 4;

const SETTLED_RETENTION_MS = 2 * 60 * 1000;

/**
 * Compact native-style footer with an optional descendant tree. Management
 * navigation uses Alt+arrow keys so ordinary arrows remain available to the
 * focused composer or custom dialog. The host owns repaint scheduling; callers
 * provide fresh immutable projections on render.
 */
export class AgentFooter implements Component {
  private readonly tui: TUI;
  private readonly theme: AgentFooterTheme;
  private readonly getInfo: () => AgentFooterInfo;
  private readonly getRows?: () => readonly FooterTreeRow[];
  private readonly onEnter?: (row: FooterTreeRow | undefined) => void;
  private readonly release?: () => void;
  private disposed = false;
  private management = false;
  private selectedIndex = 0;
  private scrollTop = 0;
  private hint: string | undefined;

  constructor(options: AgentFooterOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.getInfo = options.getInfo;
    this.getRows = options.getRows;
    this.onEnter = options.onEnter;
    this.release = options.dispose;
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, Math.floor(width));
    const info = this.getInfo();
    const pathLine = formatPathLine(info, renderWidth, this.theme);
    const statsLine = formatStatsLine(info, renderWidth, this.theme);
    const rows = filterFooterRows(this.getRows?.() ?? [], new Date());
    if (rows.length === 0) return [pathLine, statsLine];

    if (this.selectedIndex >= rows.length) this.selectedIndex = Math.max(0, rows.length - 1);

    const lastByDepth = computeLastByDepth(rows);
    const lines = [pathLine, statsLine, footerHeading(rows, this.theme)];
    if (this.hint) lines.push(this.theme.fg("warning", this.hint));
    // The heading sits directly above the tree: the root row follows the
    // heading without a blank spacer, so the header and the agent tree stay
    // visually close (same behavior as management mode).

    const visible = this.management
      ? rows.slice(this.scrollTop, this.scrollTop + MAX_VISIBLE_MANAGEMENT_ROWS)
      : rows;
    for (let index = 0; index < visible.length; index++) {
      const rowIndex = this.management ? this.scrollTop + index : index;
      const available = this.management ? Math.max(1, renderWidth - 2) : renderWidth;
      const bodyText = renderTreeRow(visible[index]!, rowIndex, rows, lastByDepth, available, this.theme);
      const selected = rowIndex === this.selectedIndex;
      const cursor = selected ? this.theme.fg("accent", "❯ ") : "  ";
      const rendered = this.management
        ? truncateToWidth(cursor + bodyText, renderWidth, this.theme.fg("dim", "..."))
        : bodyText;
      lines.push(rendered);
    }
    return lines;
  }

  /** Handle raw terminal input; returns true when the input was consumed. */
  handleInput(data: string): boolean {
    if (matchesKey(data, Key.alt(Key.down))) {
      if (!this.management) {
        this.enterManagement();
        return true;
      }
      this.moveSelection(1);
      return true;
    }
    if (this.management) {
      if (matchesKey(data, Key.alt(Key.up))) {
        this.moveSelection(-1);
        return true;
      }
      if (matchesKey(data, Key.alt(Key.left))) {
        this.exitManagement();
        return true;
      }
      if (matchesKey(data, Key.enter)) {
        const row = this.selectedRow();
        if (row && !row.enterable && !row.root) {
          this.setHint("This session is not enterable right now.");
          return true;
        }
        this.exitManagement();
        this.onEnter?.(row);
        return true;
      }
    }
    return false;
  }

  /** Show a transient hint line in the footer while management mode is active. */
  setHint(hint: string | undefined): void {
    this.hint = hint;
    this.refresh();
  }

  invalidate(): void {
    // The host owns repaint scheduling; live data subscriptions request renders.
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.release?.();
  }

  private enterManagement(): void {
    this.management = true;
    this.selectedIndex = 0;
    this.scrollTop = 0;
    this.hint = undefined;
    this.refresh();
  }

  private exitManagement(): void {
    this.management = false;
    this.hint = undefined;
    this.refresh();
  }

  private moveSelection(step: number): void {
    const rows = filterFooterRows(this.getRows?.() ?? [], new Date());
    if (rows.length === 0) return;
    this.hint = undefined;
    const next = Math.max(0, Math.min(rows.length - 1, this.selectedIndex + step));
    this.selectedIndex = next;
    if (next < this.scrollTop) this.scrollTop = next;
    if (next >= this.scrollTop + MAX_VISIBLE_MANAGEMENT_ROWS) {
      this.scrollTop = next - MAX_VISIBLE_MANAGEMENT_ROWS + 1;
    }
    this.refresh();
  }

  private selectedRow(): FooterTreeRow | undefined {
    return filterFooterRows(this.getRows?.() ?? [], new Date())[this.selectedIndex];
  }

  private refresh(): void {
    this.tui?.requestRender();
  }
}

/** Remove terminal rows after the two-minute settled retention window. */
export function filterFooterRows(
  rows: readonly FooterTreeRow[],
  now: Date,
): FooterTreeRow[] {
  const nowMs = now.getTime();
  const retained = rows.filter((row) => {
    if (!isTerminalFooterStatus(row.status)) return true;
    const settledAt = row.updatedAtMs ?? (row.updatedAt ? Date.parse(row.updatedAt) : Number.NaN);
    return !Number.isFinite(settledAt) || nowMs - settledAt <= SETTLED_RETENTION_MS;
  });

  // The root row is only an anchor for the descendant tree. Do not keep the
  // whole agent section alive after the last descendant has aged out.
  return retained.some((row) => !row.root) ? retained : [];
}

export function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${remaining}s`;
  return minutes === 0 ? `${remaining}s` : `${minutes}m ${remaining}s`;
}

/** Live status-count summary appended to the agent-section heading. */
function footerHeading(rows: readonly FooterTreeRow[], theme: AgentFooterTheme): string {
  const counts = new Map<FooterTreeStatus, number>();
  for (const row of rows) {
    if (row.root) continue;
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const status of ["running", "queued", "created", "completed", "failed", "cancelled", "interrupted", "active"] as const) {
    const count = counts.get(status);
    if (count) parts.push(`${count} ${status}`);
  }
  const summary = parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
  return theme.fg("dim", `-- current active subagents${summary} --`);
}

function isTerminalFooterStatus(status: FooterTreeStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

function computeLastByDepth(rows: readonly FooterTreeRow[]): boolean[] {
  return rows.map((row, index) => {
    for (let next = index + 1; next < rows.length; next++) {
      if (rows[next]!.depth < row.depth) return true;
      if (rows[next]!.depth === row.depth) return false;
    }
    return true;
  });
}

function renderTreeRow(
  row: FooterTreeRow,
  index: number,
  rows: readonly FooterTreeRow[],
  lastByDepth: readonly boolean[],
  width: number,
  theme: AgentFooterTheme,
): string {
  // The root row is the host session anchor; it renders a compact status line.
  if (row.root) {
    return truncateToWidth(`${statusGlyph(row.status, theme)} ${row.description} ${formatDuration(row.durationMs)}`, width, theme.fg("dim", "..."));
  }

  // The compact live line keeps the tree connectors so running agents stay
  // visually part of the descendant tree; only the body text changes shape.
  const prefix = row.depth === 0
    ? "  "
    : treePrefix(row.depth, lastByDepth, rows, index);
  const status = statusGlyph(row.status, theme);
  const live = row.live;
  const subagentType = live?.subagentType ?? row.subagentType;
  const toolUses = live?.toolUses ?? 0;
  const tokens = live?.tokens ?? 0;
  const uses = toolUses === 1 ? "1 tool use" : `${toolUses} tool uses`;
  const identity = subagentType ? `${subagentType}:${row.rowId}` : row.rowId;
  const leaf = row.leaf ? ` · ${sanitizeLeaf(row.leaf)}` : "";
  const body = `${status} ${identity} › ${row.description} · ${uses} · ${formatTokens(tokens)} tokens · ${formatDuration(row.durationMs)}${leaf}`;
  return truncateToWidth(`${prefix}${body}`, width, theme.fg("dim", "..."));
}

function treePrefix(
  depth: number,
  lastByDepth: readonly boolean[],
  rows: readonly FooterTreeRow[],
  index: number,
): string {
  const chars: string[] = [];
  // The synthetic root is not a visible branch level. A depth-1 descendant
  // starts at the left edge; deeper rows add one segment for each visible
  // ancestor branch (depth 1 through depth - 1).
  for (let level = 1; level < depth; level++) {
    const ancestorIndex = findAncestorIndex(rows, index, level);
    chars.push(ancestorIndex >= 0 && !lastByDepth[ancestorIndex] ? "│  " : "   ");
  }
  chars.push(lastByDepth[index] ? "└─ " : "├─ ");
  return chars.join("");
}

function findAncestorIndex(rows: readonly FooterTreeRow[], index: number, depth: number): number {
  for (let previous = index - 1; previous >= 0; previous--) {
    if (rows[previous]!.depth === depth) return previous;
    if (rows[previous]!.depth < depth) break;
  }
  return -1;
}

function statusGlyph(status: FooterTreeStatus, theme: AgentFooterTheme): string {
  if (status === "active" || status === "running") return theme.fg("text", "⏺");
  if (status === "completed") return theme.fg("success", "✓");
  if (status === "failed") return theme.fg("error", "✗");
  if (status === "cancelled" || status === "interrupted") return theme.fg("warning", "■");
  return theme.fg("muted", "◯");
}

function sanitizeLeaf(leaf: string): string {
  return leaf.replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim();
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(Math.max(0, Math.round(count)));
  if (count < 1_000_000) {
    const thousands = count / 1000;
    return thousands >= 100 || Number.isInteger(thousands)
      ? `${Math.round(thousands)}k`
      : `${thousands.toFixed(1)}k`;
  }
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const insideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
  if (!insideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function formatPathLine(info: AgentFooterInfo, width: number, theme: AgentFooterTheme): string {
  let path = formatCwdForFooter(info.cwd, info.home);
  if (info.branch) path += ` (${info.branch})`;
  if (info.sessionName) path += ` • ${info.sessionName}`;
  return truncateToWidth(theme.fg("dim", path), width, theme.fg("dim", "..."));
}

function formatStatsLine(info: AgentFooterInfo, width: number, theme: AgentFooterTheme): string {
  const stats: string[] = [];
  if (info.input > 0) stats.push(`↑${formatTokens(info.input)}`);
  if (info.output > 0) stats.push(`↓${formatTokens(info.output)}`);
  if (info.cacheRead > 0) stats.push(`R${formatTokens(info.cacheRead)}`);
  if (info.cacheWrite > 0) stats.push(`W${formatTokens(info.cacheWrite)}`);
  if ((info.cacheRead > 0 || info.cacheWrite > 0) && info.cacheHitRate !== undefined) {
    stats.push(`CH${info.cacheHitRate.toFixed(1)}%`);
  }
  if (info.cost > 0) stats.push(`$${info.cost.toFixed(3)}`);

  const context = info.contextPercent === null
    ? `?/${formatTokens(info.contextWindow)}`
    : `${info.contextPercent.toFixed(1)}%/${formatTokens(info.contextWindow)}`;
  stats.push(`${context}${info.autoCompactEnabled ? " (auto)" : ""}`);

  const left = stats.join(" ");
  const model = info.model ?? "no-model";
  let right = model;
  if (info.reasoning) right += ` • ${info.thinkingLevel === "off" ? "thinking off" : info.thinkingLevel ?? "off"}`;
  if (info.providerCount > 1 && info.provider) right = `(${info.provider}) ${right}`;

  const leftText = theme.fg("dim", left);
  const rightText = theme.fg("dim", right);
  const availablePadding = width - visibleWidth(leftText) - visibleWidth(rightText);
  if (availablePadding >= 2) {
    return leftText + " ".repeat(availablePadding) + rightText;
  }
  if (visibleWidth(leftText) >= width) return truncateToWidth(leftText, width, theme.fg("dim", "..."));
  const rightWidth = Math.max(0, width - visibleWidth(leftText) - 1);
  if (rightWidth === 0) return truncateToWidth(leftText, width, theme.fg("dim", "..."));
  const truncatedRight = truncateToWidth(rightText, rightWidth, "");
  return leftText + " ".repeat(Math.max(1, width - visibleWidth(leftText) - visibleWidth(truncatedRight))) + truncatedRight;
}
