import { relative, resolve, sep, isAbsolute } from "node:path";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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
  readonly dispose?: () => void;
}

const SETTLED_RETENTION_MS = 2 * 60 * 1000;

/**
 * Compact native-style footer with an optional descendant tree. The host owns
 * repaint scheduling; callers provide fresh immutable projections on render.
 */
export class AgentFooter implements Component {
  private readonly theme: AgentFooterTheme;
  private readonly getInfo: () => AgentFooterInfo;
  private readonly getRows?: () => readonly FooterTreeRow[];
  private readonly release?: () => void;
  private disposed = false;

  constructor(options: AgentFooterOptions) {
    this.theme = options.theme;
    this.getInfo = options.getInfo;
    this.getRows = options.getRows;
    this.release = options.dispose;
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, Math.floor(width));
    const info = this.getInfo();
    const pathLine = formatPathLine(info, renderWidth, this.theme);
    const statsLine = formatStatsLine(info, renderWidth, this.theme);
    const rows = filterFooterRows(this.getRows?.() ?? [], new Date());
    if (rows.length === 0) return [pathLine, statsLine];

    const lastByDepth = computeLastByDepth(rows);
    const lines = [pathLine, statsLine, this.theme.fg("dim", "-- current active subagents --")];
    for (let index = 0; index < rows.length; index++) {
      lines.push(renderTreeRow(rows[index]!, index, rows, lastByDepth, renderWidth, this.theme));
    }
    return lines;
  }

  invalidate(): void {
    // The host owns repaint scheduling; live data subscriptions request renders.
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.release?.();
  }
}

/** Remove terminal rows after the two-minute settled retention window. */
export function filterFooterRows(
  rows: readonly FooterTreeRow[],
  now: Date,
): FooterTreeRow[] {
  const nowMs = now.getTime();
  return rows.filter((row) => {
    if (!isTerminalFooterStatus(row.status)) return true;
    const settledAt = row.updatedAtMs ?? (row.updatedAt ? Date.parse(row.updatedAt) : Number.NaN);
    return !Number.isFinite(settledAt) || nowMs - settledAt <= SETTLED_RETENTION_MS;
  });
}

export function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return minutes === 0 ? `${remaining}s` : `${minutes}m ${remaining}s`;
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
  const prefix = row.root
    ? ""
    : row.depth === 0
      ? "  "
      : treePrefix(row.depth, lastByDepth, rows, index);
  const status = statusGlyph(row.status, theme);
  const leaf = row.leaf ? ` · ${sanitizeLeaf(row.leaf)}` : "";
  const text = `${prefix}${status} ${row.description} ${formatDuration(row.durationMs)}${leaf}`;
  return truncateToWidth(text, width, theme.fg("dim", "..."));
}

function treePrefix(
  depth: number,
  lastByDepth: readonly boolean[],
  rows: readonly FooterTreeRow[],
  index: number,
): string {
  const chars: string[] = [];
  for (let level = 0; level < depth - 1; level++) {
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
  if (status === "active") return theme.fg("text", "⏺");
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
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
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
