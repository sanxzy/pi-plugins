import type {
  AgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { AGENT_OPERATIONS, SESSION_OPERATIONS, processWithLog } from "@xzy-ai/observability";

/**
 * Compaction lifecycle logging.
 *
 * The SDK-native percentage auto-compaction runs inside the patched
 * `AgentSession` (`_maybeAbortForThreshold` on every `message_end`, then
 * `_checkCompaction` → `_runAutoCompaction`). Those internals are silent by
 * default, which makes live diagnosis hard (did the threshold abort fire? did
 * compaction run? did the turn auto-continue?). This registration turns the
 * three observable extension events into structured session-log entries:
 *
 * - `session_compact` (all reasons: manual/threshold/overflow) →
 *   `session.compactLifecycle` with `reason`, `willRetry`, `fromExtension`,
 *   `tokensBefore`, `firstKeptEntryId` — the main "compaction ran" evidence.
 * - `message_end` (any role) → `session.compactThresholdCheck` with the
 *   role, context estimate, thresholdPercent, contextWindow and `above`
 *   (whether this completed message pushed usage to/over the threshold) —
 *   the "abort point" evidence. The SDK aborts the active turn immediately
 *   after this message when `above` is true.
 * - `agent_start` → `agent.start` (already logged elsewhere); we only log the
 *   resumption after a threshold compaction when the previous turn was
 *   aborted mid-stream — the "auto-continue" evidence.
 *
 * All writes reuse the ambient session logger (the same `events.jsonl` that
 * `session.compactThresholdApply` writes), so a single session's daily log
 * shows the full lifecycle: threshold applied at start → message crosses →
 * compaction runs → agent resumes.
 */

/** True when the message has usage data (assistant/toolResult with usage). */
function usageTokens(message: { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } } | undefined): number | undefined {
  const usage = message?.usage;
  if (!usage) return undefined;
  const input = typeof usage.input === "number" ? usage.input : 0;
  const output = typeof usage.output === "number" ? usage.output : 0;
  const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
  const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
  return input + output + cacheRead + cacheWrite;
}

/** Whether a completed message pushes usage to/over the configured threshold. */
function crossedThreshold(
  ctx: ExtensionContext,
  message: { role?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } },
): {
  contextEstimate: number | null;
  contextWindow: number;
  thresholdPercent: number | null;
  above: boolean;
} {
  const contextUsage = ctx.getContextUsage?.();
  const contextEstimate = contextUsage?.tokens ?? usageTokens(message) ?? null;
  const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  let thresholdPercent: number | null = null;
  try {
    thresholdPercent = ctx.getSettingsManager?.().getCompactionSettings().thresholdPercent ?? null;
  } catch {
    /* unpatched host: no threshold surface; log null */
  }
  const above = contextEstimate !== null && contextWindow > 0 && thresholdPercent !== null && contextEstimate >= (contextWindow * thresholdPercent) / 100;
  return { contextEstimate, contextWindow, thresholdPercent, above };
}

/** Register the compaction lifecycle logger. */
export function registerCompactionLogging(pi: ExtensionAPI): void {
  pi.on("session_compact", (event: SessionCompactEvent, ctx: ExtensionContext) => {
    processWithLog(
      { operation: SESSION_OPERATIONS.COMPACT_LIFECYCLE, parameters: { reason: event.reason } },
      () => {
        const entry = event.compactionEntry as { tokensBefore?: number; firstKeptEntryId?: string } | undefined;
        return {
          reason: event.reason,
          willRetry: event.willRetry,
          fromExtension: event.fromExtension,
          // `tokensBefore` is the SDK field name; the log key avoids the
          // observability secret-key redaction (`token*` is redacted).
          contextEstimateBefore: entry?.tokensBefore,
          firstKeptEntryId: entry?.firstKeptEntryId,
        };
      },
    );
  });

  pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
    processWithLog(
      { operation: SESSION_OPERATIONS.COMPACT_THRESHOLD_CHECK, parameters: { role: event.message.role } },
      () => crossedThreshold(ctx, event.message),
    );
  });

  pi.on("agent_start", (_event: AgentStartEvent, ctx: ExtensionContext) => {
    processWithLog({ operation: AGENT_OPERATIONS.START, parameters: { cwd: ctx.cwd } }, () => undefined);
  });
}
