import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { resolveSettingsForProject } from "@xzy-ai/runtime";
import { SESSION_OPERATIONS, processWithLog } from "@xzy-ai/observability";

/**
 * Percentage-based forced auto-compaction for the root host session.
 *
 * The pi-c2 `config.json` setting `runtime.contextCompactThresholdPercent`
 * (default 80) defines the percentage of the model's `contextWindow` at which
 * the SDK-native auto-compaction triggers. This registration applies that
 * threshold to the root session's `SettingsManager` at `session_start` as an
 * in-memory override (`setCompactionThresholdPercent`).
 *
 * Why the SDK-native path instead of an extension `message_end` handler:
 *
 * - The SDK's `_checkCompaction` already runs after every assistant message in
 *   `_handlePostAgentRun` for root AND child sessions, and its continuation is
 *   the SDK's own `agent.continue()` loop — so after compaction the agent
 *   resumes its previous work automatically, exactly like the SDK's built-in
 *   auto-compaction, with no synthetic user message.
 * - Child agents never emit extension events (`session_start`/`message_end`),
 *   so an event-based handler can never reach them. The child-session adapter
 *   applies the same threshold to each child's own `SettingsManager` at
 *   creation (see `@xzy-ai/runtime` `child-session.ts`), which makes the
 *   percentage policy recursive down to the deepest child.
 * - The Pi host auto-compaction toggle is respected natively: `shouldCompact`
 *   and `_runAutoCompaction` both short-circuit on `compaction.enabled ===
 *   false`, so disabling Pi auto-compaction disables the percentage policy for
 *   root and children alike.
 */
export function registerContextAutoCompact(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    await processWithLog(
      { operation: SESSION_OPERATIONS.COMPACT, parameters: { cwd: ctx.cwd } },
      async () => {
        const config = resolveSettingsForProject(ctx.cwd);
        const thresholdPercent = config.runtime.contextCompactThresholdPercent;
        // Patched SDK surface: exposes the session SettingsManager so the
        // pi-c2 percentage threshold can be applied as an in-memory override
        // without persisting into Pi's settings.json. On an unpatched host
        // the surface is absent and the SDK keeps its stock reserve-token
        // auto-compaction; the percentage policy degrades gracefully.
        const settingsManager = ctx.getSettingsManager?.();
        settingsManager?.setCompactionThresholdPercent(thresholdPercent);
      },
    );
  });
}
