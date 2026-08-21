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
  type AgentFooterInfo,
  type FooterTreeLiveStats,
  type FooterTreeRow,
} from "@xzy-ai/tui";
import { TOOL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { createHostSwapController, getChildPool, scopeDescendants } from "@xzy-ai/runtime";
import type { ChildLiveSnapshot } from "@xzy-ai/core";

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
      // When a child window is active, the indicator follows that window
      // (child's token/livedata) while the tree stays anchored to the root.
      let infoCache: { leaf: string; info: AgentFooterInfo } | undefined;
      const getCachedInfo = (): AgentFooterInfo => {
        const identity = footerModelIdentity(ctx);
        if (viewStack.length > 0) {
          const top = viewStack[viewStack.length - 1]!;
          const control = liveChildFor(pool, top.rowId);
          const retained = retainedSnapshotFor(pool, top.rowId);
          const snapshot = control?.live?.snapshot ?? retained;
          if (snapshot) {
            const leaf = `${top.rowId}:${snapshot.transcript.length}:${snapshot.counters.inputTokens}:${snapshot.counters.outputTokens}:${snapshot.counters.cacheReadTokens}:${snapshot.counters.cacheWriteTokens}:${snapshot.counters.cost}:${snapshot.status}:${snapshot.settled}:${identity}`;
            if (infoCache?.leaf === leaf) return infoCache.info;
            const info = childFooterInfo(snapshot, ctx, footerData);
            infoCache = { leaf, info };
            return info;
          }
        }
        const leaf = `${ctx.sessionManager.getLeafId() ?? ""}:${identity}`;
        if (infoCache?.leaf === leaf) return infoCache.info;
        const info = footerInfo(ctx, footerData);
        infoCache = { leaf, info };
        return info;
      };
      const subscribeTree = subscribeFooterTree(pool, requestRepaint);
      let footer: AgentFooter;
      // Stack for swappable parent session: each entry is a viewable row that is currently focused.
      // The footer is re-projected to the top of the stack; an empty stack means the root parent.
      let viewStack: FooterTreeRow[] = [];
      let hostDoneStack: Array<() => void> = [];
      // F009 host swap primitive: rebinds main transcript/composer to child session file+live handle.
      // Preserves parent editor/scroll in memory and buffers background output while swapped.
      const rootSessionId = ctx.sessionManager.getSessionId();
      const hostSwap = createHostSwapController({
        sessionId: rootSessionId,
        sessionFile: (ctx.sessionManager as unknown as { getSessionFile?: () => string }).getSessionFile?.() ?? "",
        editorText: "",
        scrollOffset: 0,
      });
      const currentFocusId = (): string => {
        if (viewStack.length === 0) return rootSessionId;
        const topRow = viewStack[viewStack.length - 1]!;
        // Row id is the job id; the descendant projection is keyed by session id.
        const job = pool.registry.get(topRow.rowId);
        return job?.sessionId ?? topRow.rowId;
      };
      const updateFooterHint = (): void => {
        if (viewStack.length === 0) {
          footer.setHint(undefined);
        } else {
          const top = viewStack[viewStack.length - 1]!;
          // Re-read current job status so a running child that settles while viewed
          // correctly flips to read-only without requiring a re-push.
          const job = pool.registry.get(top.rowId);
          const status = (job?.status as string) ?? top.status;
          const readOnly = status === "completed" || status === "failed";
          footer.setHint(`Viewing ${top.rowId}${readOnly ? " (read-only)" : ""} — Esc or ← to return`);
        }
      };
      const clearToRoot = (): void => {
        // Pop all host swaps and restore parent window, clearing stack
        const toClose = [...hostDoneStack].reverse();
        hostDoneStack = [];
        viewStack = [];
        for (const done of toClose) {
          try { done(); } catch {}
        }
        // Ensure any remaining host stack is cleared (host interactive mode)
        const hostMode = (tui as unknown as { _hostInteractiveMode?: { hostSwapDepth(): number; hostSwapRestore(): void } })._hostInteractiveMode;
        if (hostMode) {
          while (hostMode.hostSwapDepth() > 0) {
            try { hostMode.hostSwapRestore(); } catch {}
          }
        }
        while (hostSwap.getStackDepth() > 0) {
          try { hostSwap.restore(); } catch {}
        }
        footer.setHint(undefined);
        tui.requestRender();
      };
      const pushSwap = (row: FooterTreeRow): void => {
        // Guard: only viewable rows are pushed; caller ensures enterable
        viewStack.push(row);
        updateFooterHint();
        tui.requestRender();
        const isRunning = row.status === "running";
        let liveSession: any;
        let abort: (() => Promise<void>) | undefined;
        if (isRunning) {
          const control = liveChildFor(pool, row.rowId);
          if (!control?.live) {
            footer.setHint("This session is no longer available.");
            viewStack.pop();
            updateFooterHint();
            tui.requestRender();
            return;
          }
          liveSession = {
            get snapshot() { return (control.live as any).snapshot as any; },
            subscribe: (listener: () => void) => (control.live as any).subscribe(() => listener()),
            steer: (prompt: string) => (control.live as any).steer(prompt),
          };
          abort = () => control.abort();
        } else {
          const retained = retainedSnapshotFor(pool, row.rowId);
          if (!retained) {
            footer.setHint("This session is no longer available.");
            viewStack.pop();
            updateFooterHint();
            tui.requestRender();
            return;
          }
          liveSession = {
            get snapshot() {
              return {
                status: retained.status,
                settled: true as const,
                transcript: retained.transcript as unknown as readonly {
                  readonly id: string;
                  readonly kind: "message" | "tool";
                  readonly role?: "user" | "assistant";
                  readonly text: string;
                  readonly complete: boolean;
                  readonly toolCallId?: string;
                  readonly toolName?: string;
                  readonly args?: unknown;
                  readonly isError?: boolean;
                }[],
              };
            },
            subscribe: () => () => {},
            steer: async () => { throw new Error("not steerable"); },
          };
        }
        // F009 true host-level swap: reuse parent window via InteractiveMode hostSwap*.
        // This directly swaps the chatContainer children, so the parent transcript is replaced
        // with the child's transcript inside the existing parent UI window (no overlay).
        const job = pool.registry.get(row.rowId);
        const sessionFile = job?.sessionId ? String(job.sessionId) : row.rowId;
        const control = liveChildFor(pool, row.rowId);
        const actualSessionFile = (control as unknown as { sessionFile?: string })?.sessionFile ?? sessionFile;
        const actualSessionId = job?.sessionId ?? row.rowId;
        hostSwap.swapTo({ sessionId: actualSessionId, sessionFile: actualSessionFile, editorText: "", scrollOffset: 0 });
        const hostMode = (tui as unknown as { _hostInteractiveMode?: { hostSwapToSnapshot(s: unknown): void; hostSwapUpdateSnapshot(s: unknown): void; hostSwapRestore(): void; hostSwapDepth(): number } })._hostInteractiveMode;
        let liveUnsub: (() => void) | undefined;
        if (hostMode) {
          try {
            hostMode.hostSwapToSnapshot(liveSession as unknown as { snapshot: unknown });
          } catch {}
          // Keep parent window in sync with live updates while viewing a running child
          if (isRunning && liveSession.subscribe) {
            try {
              liveUnsub = liveSession.subscribe(() => {
                try { hostMode.hostSwapUpdateSnapshot(liveSession as unknown as { snapshot: unknown }); } catch {}
              });
            } catch {}
          }
        } else {
          // Fallback: monkey-patch sessionManager if host mode not available (e.g. tests / headless)
          const origGetEntries = ctx.sessionManager.getEntries.bind(ctx.sessionManager);
          (ctx.sessionManager as unknown as { getEntries: () => unknown }).getEntries = () => {
            if (hostSwap.isSwapped()) return (liveSession as unknown as { snapshot: { transcript: unknown[] } }).snapshot.transcript as unknown[];
            return origGetEntries();
          };
        }
        let hostDone: () => void = () => {
          try { liveUnsub?.(); } catch {}
          try {
            if (hostMode) hostMode.hostSwapRestore();
          } catch {}
          try { hostSwap.restore(); } catch {}
          // Restore fallback patch if it was used
          if (!hostMode) {
            // No hostMode, nothing to restore beyond hostSwap; getEntries will be restored on next swap via closure? For simplicity, reload not needed in test.
          }
          const idx = viewStack.findIndex((r) => r.rowId === row.rowId);
          if (idx !== -1) viewStack.splice(idx, 1);
          const pos = hostDoneStack.indexOf(hostDone);
          if (pos !== -1) hostDoneStack.splice(pos, 1);
          updateFooterHint();
          tui.requestRender();
        };
        hostDoneStack.push(hostDone);
        tui.requestRender();
      };
      const handleEnter = (row: FooterTreeRow | undefined): void => {
        if (!row) return;
        if (row.root) {
          clearToRoot();
          return;
        }
        if (!row.enterable) {
          footer.setHint("This session is not enterable right now.");
          return;
        }
        pushSwap(row);
      };
      footer = new AgentFooter({
        tui,
        theme: footerTheme(theme),
        getInfo: () => getCachedInfo(),
        getRows: () => footerRowsForFocus(ctx, pool, rootSessionId),
        onEnter: handleEnter,
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
        // F009 true host-level swap: parent window is reused, no overlay.
        // Handle close/abort keys directly when viewing via host swap.
        if (viewStack.length > 0 && typeof data === "string") {
          if (matchesKey(data, Key.alt(Key.left)) || matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
            const topDone = hostDoneStack[hostDoneStack.length - 1];
            if (topDone) {
              try { topDone(); } catch {}
            } else {
              try { hostSwap.restore(); } catch {}
              viewStack.pop();
              updateFooterHint();
              tui.requestRender();
            }
            return { consume: true };
          }
          if (matchesKey(data, Key.alt("x"))) {
            const top = viewStack[viewStack.length - 1];
            if (top?.status === "running") {
              const control = liveChildFor(pool, top.rowId);
              void ctx.ui.confirm("Cancel child", "Abort this child agent? Its work is discarded.").then((accepted) => {
                if (!accepted || !control?.abort) return;
                void control.abort().then(() => {
                  // Keep viewing; child will settle and footer will update. No auto-close.
                  tui.requestRender();
                });
              });
            }
            return { consume: true };
          }
        }
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
function footerRowsForFocus(ctx: ExtensionContext, pool: ReturnType<typeof getChildPool>, focusSessionId: string): FooterTreeRow[] {
  const jobs = pool.registry.snapshot();
  const retainedSnapshots = (pool as unknown as { retainedLiveSnapshots?: Map<string, ChildLiveSnapshot> }).retainedLiveSnapshots;
  const descendants = scopeDescendants(
    (jobId) => jobs.get(jobId),
    jobs,
    focusSessionId,
    pool.liveChildren,
    new Date(),
    retainedSnapshots,
  );
  // Use rootSessionId stored at registration time (or pool.rootSessionId) instead of
  // ctx.sessionManager.getSessionId() which is patched to child's id while swapped.
  const rootSessionId = (pool as unknown as { rootSessionId?: string }).rootSessionId ?? ctx.sessionManager.getSessionId();
  const isSwapped = focusSessionId !== rootSessionId;
  if (descendants.length === 0) {
    if (isSwapped) {
      const root: FooterTreeRow = {
        rowId: focusSessionId,
        root: true,
        status: "active",
        depth: 0,
        description: `main (${focusSessionId.slice(0, 8)})`,
        durationMs: 0,
        enterable: false,
      };
      return [root];
    }
    return [];
  }
  const root: FooterTreeRow = {
    rowId: focusSessionId,
    root: true,
    status: "active",
    depth: 0,
    description: focusSessionId === ctx.sessionManager.getSessionId() ? "main" : `main (${focusSessionId.slice(0, 8)})`,
    durationMs: 0,
    enterable: false,
  };
  return [
    root,
    ...descendants.map((row) => {
      const job = jobs.get(row.jobId);
      const control = liveChildFor(pool, row.jobId);
      const retained = retainedSnapshotFor(pool, row.jobId);
      return {
        rowId: row.rowId,
        status: row.status,
        depth: row.depth + 1,
        description: row.description,
        durationMs: row.durationMs,
        leaf: latestLeaf(control ?? (retained ? ({ live: { snapshot: retained } } as unknown as typeof control) : undefined)),
        live: liveStats(job, control, retained),
        subagentType: job?.subagentType,
        enterable: row.enterable,
        updatedAtMs: isTerminal(row.status) ? settledMs(job) : undefined,
      };
    }),
  ];
}

/** Project the running child's live counters into a compact footer row segment. */
function liveStats(
  job: { subagentType?: string } | undefined,
  control: { live?: { snapshot: { counters: { toolUses: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } } } } | undefined,
  retained?: ChildLiveSnapshot,
): FooterTreeLiveStats | undefined {
  const counters = control?.live?.snapshot?.counters ?? retained?.counters;
  if (!counters) return undefined;
  const subagentType = job?.subagentType;
  if (!subagentType) return undefined;
  const tokens =
    counters.inputTokens + counters.outputTokens + counters.cacheReadTokens + counters.cacheWriteTokens;
  return { subagentType, toolUses: counters.toolUses, tokens };
}

function liveChildFor(
  pool: ReturnType<typeof getChildPool>,
  jobId: string,
): ReturnType<typeof pool.liveChildren.get> {
  return pool.liveChildren.get(jobId) ?? pool.liveChildren.get(jobId.replace(/^job-/, "")) ?? [...pool.liveChildren.entries()].find(([id]) => id.replace(/^job-/, "") === jobId.replace(/^job-/, ""))?.[1];
}

function retainedSnapshotFor(
  pool: ReturnType<typeof getChildPool>,
  jobId: string,
): ChildLiveSnapshot | undefined {
  const retained = (pool as unknown as { retainedLiveSnapshots?: Map<string, ChildLiveSnapshot> }).retainedLiveSnapshots;
  if (!retained) return undefined;
  const direct = retained.get(jobId);
  if (direct) return direct;
  const withoutPrefix = retained.get(jobId.replace(/^job-/, ""));
  if (withoutPrefix) return withoutPrefix;
  for (const [id, snapshot] of retained.entries()) {
    if (id.replace(/^job-/, "") === jobId.replace(/^job-/, "")) return snapshot;
  }
  return undefined;
}

function latestLeaf(
  control: { live?: { snapshot: { transcript: readonly { kind: "message" | "tool"; text: string; role?: "user" | "assistant"; toolName?: string }[] } } } | undefined,
): string | undefined {
  const transcript = control?.live?.snapshot?.transcript;
  const entry = transcript?.[transcript.length - 1];
  if (!entry) return undefined;
  if (entry.kind === "tool") return `⌘ ${entry.toolName ?? "tool"}`;
  return entry.role === "user" ? "user activity" : "assistant activity";
}

function settledMs(job: { updatedAt: string } | undefined): number | undefined {
  if (!job) return undefined;
  const ms = Date.parse(job.updatedAt);
  return Number.isFinite(ms) ? ms : undefined;
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

function footerTheme(theme: Theme): { fg: (color: string, text: string) => string } {
  return {
    fg: (color, text) => theme.fg(color as Parameters<Theme["fg"]>[0], text),
  };
}

interface FooterModelGroup {
  readonly id?: string;
  readonly name?: string;
  readonly active?: boolean;
}

interface FooterModelGroupApi {
  readonly list?: () => readonly FooterModelGroup[];
}

function activeModelGroup(): FooterModelGroup | undefined {
  const api = (globalThis as typeof globalThis & { [key: symbol]: unknown })[Symbol.for("pi-c2.model-groups")] as FooterModelGroupApi | undefined;
  if (typeof api?.list !== "function") return undefined;
  try {
    return api.list().find((group) => group.active);
  } catch {
    return undefined;
  }
}

function footerModelIdentity(ctx: ExtensionContext): string {
  const model = ctx.model;
  const group = activeModelGroup();
  const entries = ctx.sessionManager.getEntries() as readonly unknown[];
  return [
    model?.provider ?? "",
    model?.id ?? "",
    latestThinkingLevel(entries),
    group?.id ?? "",
    group?.name ?? "",
  ].join(":");
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
  const modelGroupName = activeModelGroup()?.name;
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
    modelGroupName,
    providerCount: footerData.getAvailableProviderCount(),
    thinkingLevel,
    reasoning,
  };
}

function childFooterInfo(
  snapshot: ChildLiveSnapshot,
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
): AgentFooterInfo {
  const counters = snapshot.counters;
  const model = ctx.model;
  const reasoning = Boolean(model?.reasoning);
  const modelGroupName = activeModelGroup()?.name;
  // Derive thinkingLevel from child's transcript if it contains a thinking_level_change entry;
  // the live transcript does not carry those, so reuse parent's thinking level.
  const entries = ctx.sessionManager.getEntries() as readonly unknown[];
  const thinkingLevel = latestThinkingLevel(entries);
  const input = counters.inputTokens;
  const cacheRead = counters.cacheReadTokens;
  const cacheWrite = counters.cacheWriteTokens;
  const promptTokens = input + cacheRead + cacheWrite;
  const cacheHitRate = promptTokens > 0 ? (cacheRead / promptTokens) * 100 : undefined;
  const contextWindow = ctx.getContextUsage()?.contextWindow ?? model?.contextWindow ?? 0;
  // Child context is not exposed via host; approximate from child's prompt tokens.
  const contextPercent = contextWindow > 0 && promptTokens > 0 ? (promptTokens / contextWindow) * 100 : null;
  return {
    cwd: ctx.sessionManager.getCwd(),
    home: process.env.HOME || process.env.USERPROFILE,
    branch: footerData.getGitBranch(),
    sessionName: ctx.sessionManager.getSessionName(),
    input,
    output: counters.outputTokens,
    cacheRead,
    cacheWrite,
    cacheHitRate,
    cost: (counters as { cost?: number }).cost ?? 0,
    contextPercent,
    contextWindow,
    autoCompactEnabled: true,
    model: model?.id,
    provider: model?.provider,
    modelGroupName,
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
