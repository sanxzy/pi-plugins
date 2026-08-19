import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { clearSettingsCache, resolveSettingsForProject } from "@xzy-ai/runtime";
import {
  COMPACT_THRESHOLD_DEFAULT,
  COMPACT_THRESHOLD_MAX,
  COMPACT_THRESHOLD_MIN,
  parseCompactThreshold,
  registerManageCompactThreshold,
  setCompactThreshold,
} from "../src/registrations/manage-compact-threshold.ts";

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<unknown> | unknown;

function home(): string { return mkdtempSync(join(tmpdir(), "pi-c2-mct-home-")); }

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

function readHomeConfig(homeRoot: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(homeRoot, "pi-c2", "config.json"), "utf8")) as Record<string, unknown>;
}

test("parseCompactThreshold accepts integers within 50-90 and rejects everything else", () => {
  assert.equal(parseCompactThreshold("80"), 80);
  assert.equal(parseCompactThreshold(" 50 "), 50);
  assert.equal(parseCompactThreshold("90"), 90);
  assert.equal(parseCompactThreshold("49"), undefined, "below min rejected");
  assert.equal(parseCompactThreshold("91"), undefined, "above max rejected");
  assert.equal(parseCompactThreshold(""), undefined, "empty rejected");
  assert.equal(parseCompactThreshold("abc"), undefined, "non-numeric rejected");
  assert.equal(parseCompactThreshold("80.5"), undefined, "fraction rejected");
  assert.equal(parseCompactThreshold("-5"), undefined, "negative rejected");
});

test("setCompactThreshold persists runtime.contextCompactThresholdPercent and clears the cache", async () => {
  const h = home();
  try {
    await withHome(h, async () => {
      writeHomeConfig(h, { runtime: { contextCompactThresholdPercent: 80 }, agents: { model: "keep" } });
      const result = setCompactThreshold(65);
      assert.equal(result.ok, true);
      const config = readHomeConfig(h);
      const runtime = config.runtime as Record<string, unknown>;
      assert.equal(runtime.contextCompactThresholdPercent, 65, "threshold persisted");
      assert.equal((config.agents as Record<string, unknown>).model, "keep", "unrelated keys preserved");
      assert.equal(resolveSettingsForProject(undefined).runtime.contextCompactThresholdPercent, 65, "cache cleared, new value resolved");
    });
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("setCompactThreshold reports no-change when the value is identical", async () => {
  const h = home();
  try {
    await withHome(h, async () => {
      writeHomeConfig(h, { runtime: { contextCompactThresholdPercent: 70 } });
      const result = setCompactThreshold(70);
      assert.equal(result.ok, true);
      assert.match(result.message, /already 70%/);
    });
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("registerManageCompactThreshold registers the command with bounds in the description", () => {
  const commands = new Map<string, { description: string }>();
  const pi = {
    registerCommand(name: string, definition: { description: string }) {
      commands.set(name, definition);
    },
  } as unknown as ExtensionAPI;
  registerManageCompactThreshold(pi);
  const definition = commands.get("c2-manage-compact-threshold");
  assert.ok(definition, "command registered");
  assert.match(definition.description, /50-90/);
  assert.match(definition.description, /default 80/);
});

test("command handler prompts, validates, and persists the threshold", async () => {
  const h = home();
  try {
    await withHome(h, async () => {
      writeHomeConfig(h, { runtime: { contextCompactThresholdPercent: 80 } });
      const notifications: string[] = [];
      let inputAnswer: string | undefined = "75";
      let capturedPrefill = "";
      const ctx = {
        cwd: process.cwd(),
        signal: undefined,
        ui: {
          custom: async <T>(factory: (tui: unknown, theme: unknown, _keybindings: unknown, done: (result: T) => void) => unknown) => {
            // Mount the dialog with a captured prefill and drive `done` with the
            // scripted answer (mirrors the host's ctx.ui.custom() contract).
            let resolveDone: ((value: T) => void) | undefined;
            const done = (result: T) => { resolveDone?.(result); };
            const promise = new Promise<T>((resolve) => { resolveDone = resolve; });
            const component = factory(
              { terminal: { rows: 24 }, requestRender: () => {} },
              { fg: (_color: string, text: string) => text },
              undefined,
              done,
            ) as { editor?: { getText(): string } } & { render(width: number): string[]; handleInput?(data: string): void };
            capturedPrefill = (component as unknown as { editor: { getText(): string } }).editor?.getText() ?? "";
            // Simulate submit (enter) with the scripted answer: set the editor
            // text and invoke onSubmit via handleInput enter.
            if (inputAnswer !== undefined) {
              const editor = (component as unknown as { editor: { setText(t: string): void; onSubmit?: (v: string) => void } }).editor;
              editor.setText(inputAnswer);
              editor.onSubmit?.(inputAnswer);
            } else {
              component.handleInput?.("\x1b"); // escape cancels
            }
            return promise;
          },
          notify: (message: string) => { notifications.push(message); },
        },
      } as unknown as ExtensionCommandContext;

      const commands = new Map<string, { handler: Handler }>();
      const pi = {
        registerCommand(name: string, definition: { handler: Handler }) {
          commands.set(name, definition);
        },
      } as unknown as ExtensionAPI;
      registerManageCompactThreshold(pi);
      const handler = commands.get("c2-manage-compact-threshold")!.handler;
      await handler("", ctx);

      assert.equal(capturedPrefill, "80", "dialog pre-fills the current threshold (80) when config has 80");
      assert.equal(resolveSettingsForProject(undefined).runtime.contextCompactThresholdPercent, 75, "threshold persisted via command");
      assert.equal(notifications.length, 1);
      assert.match(notifications[0], /set to 75%/);

      // A later invocation must pre-fill the NEW current threshold (75), not the default 80.
      await handler("", ctx);
      assert.equal(capturedPrefill, "75", "dialog pre-fill reflects the updated current threshold");

      // Invalid input: no change, error notification.
      inputAnswer = "120";
      await handler("", ctx);
      assert.equal(resolveSettingsForProject(undefined).runtime.contextCompactThresholdPercent, 75, "invalid input does not change the threshold");
      assert.match(notifications[notifications.length - 1], /Invalid threshold/);

      // Cancel (undefined): info notification, no change.
      inputAnswer = undefined;
      await handler("", ctx);
      assert.equal(resolveSettingsForProject(undefined).runtime.contextCompactThresholdPercent, 75, "cancel does not change the threshold");
      assert.match(notifications[notifications.length - 1], /cancelled/);
    });
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("command uses the default 80 when the config omits the threshold", async () => {
  const h = home();
  try {
    await withHome(h, async () => {
      assert.equal(COMPACT_THRESHOLD_DEFAULT, 80);
      assert.equal(COMPACT_THRESHOLD_MIN, 50);
      assert.equal(COMPACT_THRESHOLD_MAX, 90);
      assert.equal(resolveSettingsForProject(undefined).runtime.contextCompactThresholdPercent, 80, "unset threshold defaults to 80");
    });
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});
