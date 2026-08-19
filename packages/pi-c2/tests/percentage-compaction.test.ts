import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { shouldCompact, SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * Percentage-based auto-compaction tests.
 *
 * The pi-c2 patch extends the SDK's compaction settings with an optional
 * `thresholdPercent`. When set, `shouldCompact` compares context usage against
 * `contextWindow * thresholdPercent / 100` instead of the reserve-token math,
 * and `SettingsManager.getCompactionSettings()` surfaces the value. This is
 * the seam that makes forced percentage compaction work for root AND child
 * sessions (children never emit extension events, so the SDK-native
 * `_checkCompaction` path is the only mechanism that reaches them).
 */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-c2-pct-compact-"));
}

test("shouldCompact triggers at the configured percentage of the context window", () => {
  const settings = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, thresholdPercent: 80 };
  const contextWindow = 200_000;
  // 80% of 200k = 160k. Exactly at the boundary triggers.
  assert.equal(shouldCompact(160_000, contextWindow, settings), true, "at 80% triggers");
  assert.equal(shouldCompact(159_999, contextWindow, settings), false, "just below 80% does not trigger");
  assert.equal(shouldCompact(200_000, contextWindow, settings), true, "100% triggers");
});

test("shouldCompact honors a custom percentage threshold", () => {
  const contextWindow = 100_000;
  const settings = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, thresholdPercent: 90 };
  assert.equal(shouldCompact(89_999, contextWindow, settings), false);
  assert.equal(shouldCompact(90_000, contextWindow, settings), true);
});

test("shouldCompact falls back to reserve-token math when no thresholdPercent is set", () => {
  const settings = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };
  const contextWindow = 200_000;
  // Reserve-token math: contextTokens > 200000 - 16384 = 183616.
  assert.equal(shouldCompact(183_616, contextWindow, settings), false, "at the reserve boundary does not trigger (strict >)");
  assert.equal(shouldCompact(183_617, contextWindow, settings), true, "above the reserve boundary triggers");
});

test("shouldCompact respects the enabled flag regardless of thresholdPercent", () => {
  const contextWindow = 100_000;
  const settings = { enabled: false, reserveTokens: 16384, keepRecentTokens: 20000, thresholdPercent: 50 };
  assert.equal(shouldCompact(100_000, contextWindow, settings), false, "disabled auto-compaction never triggers");
});

test("SettingsManager surfaces the configured thresholdPercent through getCompactionSettings", () => {
  const cwd = tempDir();
  try {
    const settingsManager = SettingsManager.create(cwd, join(cwd, "agent"));
    settingsManager.applyOverrides({ compaction: { thresholdPercent: 75 } });
    const settings = settingsManager.getCompactionSettings();
    assert.equal(settings.thresholdPercent, 75);
    assert.equal(settings.enabled, true, "host auto-compaction default stays enabled");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("SettingsManager applyOverrides thresholdPercent survives a settings save re-merge", async () => {
  const cwd = tempDir();
  try {
    const settingsManager = SettingsManager.create(cwd, join(cwd, "agent"));
    settingsManager.applyOverrides({ compaction: { thresholdPercent: 70 } });
    // A model change triggers save(), which re-merges from storage. The
    // thresholdPercent override must survive so the percentage policy is not
    // silently dropped mid-session.
    settingsManager.setDefaultModelAndProvider("test-provider", "test-model");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(settingsManager.getCompactionSettings().thresholdPercent, 70);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
