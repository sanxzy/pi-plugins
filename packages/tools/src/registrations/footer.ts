import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
  Theme,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import {
  AgentFooter,
  AgentLiveManager,
  type AgentFooterInfo,
  type FooterTreeRow,
} from "@xzy-ai/tui";
import { TOOL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { getChildPool, scopeDescendants } from "@xzy-ai/runtime";

/** Debounce job-status and live-leaf repaints so bursty child activity coalesces. */
const REPAINT_DEBOUNCE_MS = 250;

/**
 * Heartbeat cadence that advances running child timers while a long quiet tool
 * call emits no transcript events. Rendered durations are computed from the
 * wall clock at render time, but renders are otherwise event-driven; without
 * this tick the footer's elapsed timer freezes during silent running work.
 */
const FOOTER_HEARTBEAT_MS = 1_000;

/**
 * Request a repaint once per interval while at least one live child feed is
 * running. Unsubscribe stops the interval. The heartbeat never fires for
 * settled children and makes no assumptions about their transcripts.
 */
export function createFooterHeartbeat(
  liveChildren: ReadonlyMap<string, { live?: { snapshot?: { status?: string } } }>,
  repaint: () => void,
  intervalMs: number = FOOTER_HEARTBEAT_MS,
): () => void {
  const hasRunning = (): boolean => {
    for (const child of liveChildren.values()) {
      const status = child.live?.snapshot?.status;
      // An unknown live status is treated as running so the heartbeat stays
      // conservative (safe over-repaint rather than a frozen timer).
      if (status === undefined || status === "running") return true;
    }
    return false;
  };
  const heartbeat = setInterval(() => {
    if (hasRunning()) repaint();
  }, intervalMs);
  heartbeat.unref?.();
  return () => clearInterval(heartbeat);
}

/** Install the permanent native-information footer for TUI sessions. */
export function registerAgentFooter(pi: ExtensionAPI): void {
  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    // The footer is a TUI-only surface; any other mode must stay telemetry-silent.
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    processWithLog({ operation: TOOL_OPERATIONS.FOOTER_START, parameters: { cwd: ctx.cwd } }, () => {
    // The root session id scopes the descendant projection; the pool is created
    // with it so the root (which is not a job) is the tree root.
    const pool = getChildPool(ctx.cwd, ctx.sessionManager.getSessionId());
    ctx.ui.setFooter((tui, theme, footerData) => {
      let repaintTimer: ReturnType<typeof setTimeout> | undefined;
      const requestRepaint = (): void => {
        if (repaintTimer) return;
        repaintTimer = setTimeout(
          () => {
            repaintTimer = undefined;
            tui.requestRender();
          },
          REPAINT_DEBOUNCE_MS,
        );
      };
      const branchUnsubscribe = footerData.onBranchChange(() => tui.requestRender());
      // Footer info is re-derived lazily from `ctx.sessionManager.getEntries()`
      // on every repaint. Memoize it per leaf id: the entries list is append-only
      // and the leaf id is the cache key that advances on every new message, so a
      // repaint between messages reuses the prior work instead of scanning the
      // whole transcript again (the main remaining per-keystroke cost).
      let infoCache: { leaf: string; info: AgentFooterInfo } | undefined;
      const getCachedInfo = (): AgentFooterInfo => {
        const leaf = ctx.sessionManager.getLeafId() ?? "";
        if (infoCache?.leaf === leaf) return infoCache.info;
        const info = footerInfo(ctx, footerData);
        infoCache = { leaf, info };
        return info;
      };
      const subscribeTree = subscribeFooterTree(pool, requestRepaint);
      const footer = new AgentFooter({
        tui,
        theme: footerTheme(theme),
        getInfo: () => getCachedInfo(),
        getRows: () => footerRows(ctx, pool),
        onEnter: (row) => openChildLiveView(ctx, pool, footer, row),
        dispose: () => {
          if (repaintTimer !== undefined) {
            clearTimeout(repaintTimer);
            repaintTimer = undefined;
          }
          branchUnsubscribe();
          subscribeTree();
        },
      });
      // Route raw terminal input to the footer's management mode. Navigation
      // keys are consumed here (never reaching the composer); all other input
      // passes through unchanged.
      const stopInput = ctx.ui.onTerminalInput((data) => {
        if (footer.handleInput(data)) return { consume: true };
        return { consume: false, data };
      });
      const superDispose = footer.dispose.bind(footer);
      footer.dispose = () => {
        stopInput();
        superDispose();
      };
      return footer;
    });
    });
  });

  pi.on("session_shutdown", (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
    // Symmetric with session_start: non-TUI sessions never had a footer, so
    // leaving the surface alone, and no telemetry noise either.
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    processWithLog({ operation: TOOL_OPERATIONS.FOOTER_STOP, parameters: { cwd: ctx.cwd } }, () => {
    const pool = getChildPool(ctx.cwd);
    if (!pool.isRootSession(ctx.sessionManager.getSessionId()) && !pool.shouldBootstrapRootSession(ctx.sessionManager.getSessionId())) return;
    ctx.ui.setFooter(undefined);
    });
  });
}

/**
 * Subscribe to the runtime's per-job transitions and live-child feed so the
 * footer's descendant tree repaints as jobs move and transcripts advance. The
 * subscription is independent of child control: it never aborts or steers.
 */
function subscribeFooterTree(
  pool: ReturnType<typeof getChildPool>,
  repaint: () => void,
): () => void {
  const subscriptions = new Map<string, () => void>();

  const attachLiveChildren = (): void => {
    for (const [jobId, control] of pool.liveChildren) {
      if (subscriptions.has(jobId) || !control.live) continue;
      const live = control.live;
      subscriptions.set(jobId, live.subscribe(() => repaint()));
    }
    for (const jobId of [...subscriptions.keys()]) {
      if (pool.liveChildren.has(jobId)) continue;
      subscriptions.get(jobId)?.();
      subscriptions.delete(jobId);
    }
  };

  // The registry has no event emitter; poll the scoped descendant projection on
  // the same debounce cadence so newly created/settled jobs appear in the tree.
  // The poll never blocks process exit; the host keeps the process alive while
  // the footer is installed, and dispose() clears the interval explicitly.
  const poll = setInterval(attachLiveChildren, REPAINT_DEBOUNCE_MS);
  poll.unref();
  attachLiveChildren();
  // A second, slower cadence keeps running child timers advancing while a long
  // quiet tool call emits no transcript events; see createFooterHeartbeat.
  const stopHeartbeat = createFooterHeartbeat(pool.liveChildren, repaint);
  return () => {
    clearInterval(poll);
    stopHeartbeat();
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
  };
}

/** Project the root session's descendant scope into footer tree rows. */
function footerRows(ctx: ExtensionContext, pool: ReturnType<typeof getChildPool>): FooterTreeRow[] {
  const rootSessionId = ctx.sessionManager.getSessionId();
  // Consume the in-memory registry snapshot: `pool.registry.all()`/`get()`
  // rescan and re-parse every home event log synchronously, which made every
  // footer repaint O(all logs). Lifecycle writes and explicit `refresh()`
  // publish a fresh snapshot reference, so this stays authoritative over time.
  const jobs = pool.registry.snapshot();
  const descendants = scopeDescendants(
    (jobId) => jobs.get(jobId),
    jobs,
    rootSessionId,
    pool.liveChildren,
    new Date(),
  );
  if (descendants.length === 0) return [];

  const root: FooterTreeRow = {
    rowId: rootSessionId,
    root: true,
    status: "active",
    depth: 0,
    description: "main",
    durationMs: 0,
    enterable: false,
  };
  return [
    root,
    ...descendants.map((row) => ({
      rowId: row.rowId,
      status: row.status,
      depth: row.depth + 1,
      description: row.description,
      durationMs: row.durationMs,
      leaf: latestLeaf(liveChildFor(pool, row.jobId)),
      enterable: row.enterable,
      updatedAtMs: isTerminal(row.status) ? settledMs(jobs.get(row.jobId)) : undefined,
    })),
  ];
}

function liveChildFor(
  pool: ReturnType<typeof getChildPool>,
  jobId: string,
): ReturnType<typeof pool.liveChildren.get> {
  return pool.liveChildren.get(jobId) ?? pool.liveChildren.get(jobId.replace(/^job-/, "")) ?? [...pool.liveChildren.entries()].find(([id]) => id.replace(/^job-/, "") === jobId.replace(/^job-/, ""))?.[1];
}

function latestLeaf(
  control: { live?: { snapshot: { transcript: readonly { kind: "message" | "tool"; text: string; toolName?: string }[] } } } | undefined,
): string | undefined {
  const transcript = control?.live?.snapshot?.transcript;
  const entry = transcript?.[transcript.length - 1];
  if (!entry) return undefined;
  if (entry.kind === "tool") return `⌘ ${entry.toolName ?? "tool"}`;
  const text = entry.text.replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim();
  return text || undefined;
}

function settledMs(job: { updatedAt: string } | undefined): number | undefined {
  if (!job) return undefined;
  const ms = Date.parse(job.updatedAt);
  return Number.isFinite(ms) ? ms : undefined;
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

/** Mount a focused live child view without changing the host session. */
function openChildLiveView(
  ctx: ExtensionContext,
  pool: ReturnType<typeof getChildPool>,
  footer: AgentFooter,
  row: FooterTreeRow | undefined,
): void {
  if (!row || row.root || !row.enterable || row.status !== "running") return;
  const control = liveChildFor(pool, row.rowId);
  if (!control?.live) {
    footer.setHint("This session is no longer available.");
    return;
  }
  const live = control.live;
  ctx.ui.custom(
    (tui, theme, _keybindings, done) => new AgentLiveManager({
      tui,
      theme: footerTheme(theme),
      live: {
        get snapshot() {
          return live.snapshot;
        },
        subscribe: (listener) => live.subscribe(() => listener()),
        steer: (prompt) => live.steer(prompt),
      },
      abort: () => control.abort(),
      confirm: (title, message) => ctx.ui.confirm(title, message),
      done: () => done(undefined),
    }),
    { overlay: true, overlayOptions: { anchor: "center", width: "80%" } },
  );
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
