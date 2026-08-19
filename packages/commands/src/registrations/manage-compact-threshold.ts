import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { COMMAND_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { clearSettingsCache, resolveSettingsForProject, settingsConfigPath } from "@xzy-ai/runtime";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * Allowed range for the percentage-based auto-compaction threshold managed
 * through `/manage-compact-threshold`. The default is 80; users may set any
 * integer from 50 (inclusive) to 90 (inclusive).
 */
export const COMPACT_THRESHOLD_MIN = 50;
export const COMPACT_THRESHOLD_MAX = 90;
export const COMPACT_THRESHOLD_DEFAULT = 80;

/** Read the home settings config as a plain object; malformed or missing input degrades to `{}`. */
function readSettingsConfig(filePath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Write the settings config with the same formatting the bootstrap uses. */
function writeSettingsConfig(filePath: string, value: Record<string, unknown>): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Parse a user-supplied threshold value; returns undefined when invalid. */
export function parseCompactThreshold(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) return undefined;
  if (parsed < COMPACT_THRESHOLD_MIN || parsed > COMPACT_THRESHOLD_MAX) return undefined;
  return parsed;
}

/**
 * Persist the percentage-based auto-compaction threshold to the home
 * `config.json` (`runtime.contextCompactThresholdPercent`) and clear the
 * settings cache so the root `session_start` handler and every child-session
 * adapter pick up the new value. Returns a human-readable result.
 */
export function setCompactThreshold(percent: number): { ok: true; message: string } | { ok: false; message: string } {
  const configPath = settingsConfigPath();
  try {
    const config = readSettingsConfig(configPath);
    const runtime =
      typeof config.runtime === "object" && config.runtime !== null && !Array.isArray(config.runtime)
        ? { ...(config.runtime as Record<string, unknown>) }
        : {};
    const same = runtime.contextCompactThresholdPercent === percent;
    runtime.contextCompactThresholdPercent = percent;
    writeSettingsConfig(configPath, { ...config, runtime });
    clearSettingsCache();
    if (same) {
      return { ok: true, message: `Auto-compaction threshold is already ${percent}%; no change was needed.` };
    }
    return { ok: true, message: `Auto-compaction threshold set to ${percent}% (applies to new and continuing sessions).` };
  } catch (error) {
    return {
      ok: false,
      message: `Could not write ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Register the `/manage-compact-threshold` command. */
export function registerManageCompactThreshold(pi: ExtensionAPI): void {
  pi.registerCommand("manage-compact-threshold", {
    description: "View or change the context-usage percentage that triggers automatic compaction (50-90, default 80)",
    async handler(_args: string, ctx: ExtensionCommandContext): Promise<void> {
      return processWithLog({ operation: COMMAND_OPERATIONS.MANAGE_COMPACT_THRESHOLD }, async () => {
        const current = resolveSettingsForProject(ctx.cwd).runtime.contextCompactThresholdPercent;
        const input = await ctx.ui.input(
          `Auto-compaction triggers when context usage reaches ${current}% of the model's context window. Enter a new threshold (${COMPACT_THRESHOLD_MIN}-${COMPACT_THRESHOLD_MAX}, default ${COMPACT_THRESHOLD_DEFAULT}):`,
          String(COMPACT_THRESHOLD_DEFAULT),
        );
        if (input === undefined) {
          ctx.ui.notify("Compact-threshold management cancelled", "info");
          return;
        }
        const percent = parseCompactThreshold(input);
        if (percent === undefined) {
          ctx.ui.notify(
            `Invalid threshold "${input}": must be an integer between ${COMPACT_THRESHOLD_MIN} and ${COMPACT_THRESHOLD_MAX}.`,
            "error",
          );
          return;
        }
        const result = setCompactThreshold(percent);
        ctx.ui.notify(result.message, result.ok ? "info" : "error");
      });
    },
  });
}
