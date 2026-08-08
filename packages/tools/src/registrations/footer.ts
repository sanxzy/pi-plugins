import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
  Theme,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { AgentFooter, type AgentFooterInfo } from "@xzy-ai/tui";
import { getChildPool } from "@xzy-ai/runtime";

/** Install the permanent native-information footer for TUI sessions. */
export function registerAgentFooter(pi: ExtensionAPI): void {
  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    ctx.ui.setFooter((tui, theme, footerData) => {
      const branchUnsubscribe = footerData.onBranchChange(() => tui.requestRender());
      const footer = new AgentFooter({
        tui,
        theme: footerTheme(theme),
        getInfo: () => footerInfo(ctx, footerData),
        dispose: branchUnsubscribe,
      });
      return footer;
    });
  });

  pi.on("session_shutdown", (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
    const pool = getChildPool(ctx.cwd);
    if (pool.registry.get(ctx.sessionManager.getSessionId()) !== undefined) return;
    ctx.ui.setFooter(undefined);
  });
}

function footerTheme(theme: Theme): { fg: (color: string, text: string) => string } {
  return {
    fg: (color, text) => theme.fg(color as Parameters<Theme["fg"]>[0], text),
  };
}

function footerInfo(
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
): AgentFooterInfo {
  const entries = ctx.sessionManager.getEntries() as readonly unknown[];
  const usage = collectUsage(entries);
  const contextUsage = ctx.getContextUsage();
  const model = ctx.model;
  const reasoning = Boolean(model?.reasoning);
  const thinkingLevel = latestThinkingLevel(entries);
  return {
    cwd: ctx.sessionManager.getCwd(),
    home: process.env.HOME || process.env.USERPROFILE,
    branch: footerData.getGitBranch(),
    sessionName: ctx.sessionManager.getSessionName(),
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cacheHitRate: usage.cacheHitRate,
    cost: usage.cost,
    contextPercent: contextUsage?.percent ?? null,
    contextWindow: contextUsage?.contextWindow ?? model?.contextWindow ?? 0,
    autoCompactEnabled: true,
    model: model?.id,
    provider: model?.provider,
    providerCount: footerData.getAvailableProviderCount(),
    thinkingLevel,
    reasoning,
  };
}

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  cacheHitRate?: number;
}

function collectUsage(entries: readonly unknown[]): UsageTotals {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of entries) {
    const record = asRecord(entry);
    let usage = asUsage(record?.usage);
    if (record?.type === "message") {
      const message = asRecord(record.message);
      if (message?.role === "assistant" || message?.role === "toolResult") usage = usage ?? asUsage(message.usage);
    }
    if (!usage) continue;
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.cost += usage.cost;
    // The cache-hit rate reflects the latest assistant prompt only.
    if (record?.type === "message") {
      const message = asRecord(record.message);
      if (message?.role === "assistant") {
        const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
        totals.cacheHitRate = promptTokens > 0 ? usage.cacheRead / promptTokens * 100 : undefined;
      }
    }
  }
  return totals;
}

function latestThinkingLevel(entries: readonly unknown[]): string {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = asRecord(entries[index]);
    if (entry?.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
      return entry.thinkingLevel;
    }
  }
  return "off";
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" ? value as Record<string, any> : undefined;
}

function asUsage(value: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const cost = asRecord(usage.cost);
  return {
    input: numberValue(usage.input),
    output: numberValue(usage.output),
    cacheRead: numberValue(usage.cacheRead),
    cacheWrite: numberValue(usage.cacheWrite),
    cost: numberValue(cost?.total),
  };
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
