import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { clearSettingsCache } from "@xzy-ai/runtime";
import { registerContextAutoCompact } from "../src/registrations/context-auto-compact.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function home(): string { return mkdtempSync(join(tmpdir(), "pi-c2-auto-compact-home-")); }
function project(): string { return mkdtempSync(join(tmpdir(), "pi-c2-auto-compact-project-")); }

function withHome(homeRoot: string, run: () => Promise<void>): Promise<void> {
  const previous = process.env.PI_C2_TEST_HOME;
  process.env.PI_C2_TEST_HOME = homeRoot; clearSettingsCache();
  return run().finally(() => {
    if (previous === undefined) delete process.env.PI_C2_TEST_HOME;
    else process.env.PI_C2_TEST_HOME = previous;
    clearSettingsCache();
  });
}

function writeHomeConfig(homeRoot: string, value: unknown): void {
  const dir = join(homeRoot, "pi-c2");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(value));
}

interface FakeSettingsManager {
  threshold: number | undefined;
  setCompactionThresholdPercent(percent: number): void;
}

function registrations(): { pi: ExtensionAPI; handlers: Map<string, Handler>; settings: FakeSettingsManager } {
  const handlers = new Map<string, Handler>();
  const settings: FakeSettingsManager = { threshold: undefined, setCompactionThresholdPercent(percent) { this.threshold = percent; } };
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  registerContextAutoCompact(pi);
  return { pi, handlers, settings };
}

function context(cwd: string, settings: FakeSettingsManager): ExtensionContext {
  return {
    cwd,
    mode: "tui",
    hasUI: true,
    getSettingsManager: () => settings as unknown as ExtensionContext["getSettingsManager"] extends () => infer R ? R : never,
  } as unknown as ExtensionContext;
}

test("session_start applies the configured percentage threshold to the root SettingsManager", async () => {
  const h = home(); const cwd = project();
  try {
    writeHomeConfig(h, { runtime: { contextCompactThresholdPercent: 65 } });
    await withHome(h, async () => {
      const { handlers, settings } = registrations();
      const handler = handlers.get("session_start");
      assert.ok(handler, "session_start handler must be registered");
      await handler({ type: "session_start", reason: "startup" } as SessionStartEvent, context(cwd, settings));
      assert.equal(settings.threshold, 65, "configured 65% is applied");
    });
  } finally {
    rmSync(h, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session_start applies the default 80 when the config omits the threshold", async () => {
  const h = home(); const cwd = project();
  try {
    await withHome(h, async () => {
      const { handlers, settings } = registrations();
      const handler = handlers.get("session_start")!;
      await handler({ type: "session_start", reason: "startup" } as SessionStartEvent, context(cwd, settings));
      assert.equal(settings.threshold, 80, "default 80 is applied");
    });
  } finally {
    rmSync(h, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
