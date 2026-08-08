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

export interface AgentFooterOptions {
  readonly tui: TUI;
  readonly theme: AgentFooterTheme;
  readonly getInfo: () => AgentFooterInfo;
  readonly dispose?: () => void;
}

/**
 * Compact native-style footer. Agent rows are added in a later phase; this
 * component owns the stable information rows and host subscription lifecycle.
 */
export class AgentFooter implements Component {
  private readonly tui: TUI;
  private readonly theme: AgentFooterTheme;
  private readonly getInfo: () => AgentFooterInfo;
  private readonly release?: () => void;
  private disposed = false;

  constructor(options: AgentFooterOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.getInfo = options.getInfo;
    this.release = options.dispose;
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, Math.floor(width));
    const info = this.getInfo();
    const pathLine = formatPathLine(info, renderWidth, this.theme);
    const statsLine = formatStatsLine(info, renderWidth, this.theme);
    return [pathLine, statsLine];
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
