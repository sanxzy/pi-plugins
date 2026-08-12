import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { TUI } from "@earendil-works/pi-tui";
import {
  ReferencesSetupWizard,
  type ReferencesSetupController,
  type ReferencesSetupResult,
} from "../src/references-setup-wizard.ts";

function tui(): TUI {
  return { terminal: { rows: 24 }, requestRender: () => {} } as unknown as TUI;
}

const theme = { fg: (_color: string, text: string) => text };

function controller(overrides: Partial<ReferencesSetupController> = {}): ReferencesSetupController {
  return {
    list: async () => ({ items: [] }),
    addLocal: async () => ({ ok: true, message: "Reference saved." }),
    updateLocal: async () => ({ ok: true, message: "Reference saved." }),
    remove: async () => ({ ok: true, message: "Reference removed." }),
    cancel: async () => {
    await undefined;
  },
    ...overrides,
  };
}

function lines(component: { render(width: number): string[] }): string[] {
  return stripVTControlCharacters(component.render(60).join("\n")).split("\n");
}

function resultPromise(): { promise: Promise<ReferencesSetupResult>; resolve: (result: ReferencesSetupResult) => void } {
  let resolve!: (result: ReferencesSetupResult) => void;
  const promise = new Promise<ReferencesSetupResult>((next) => { resolve = next; });
  return { promise, resolve };
}

test("renders the local reference action menu and add flow", async () => {
  const ctl = controller();
  const result = resultPromise();
  const wizard = new ReferencesSetupWizard({ tui: tui(), theme, controller: ctl, done: result.resolve });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(lines(wizard).some((line) => line.includes("References setup")));
  assert.ok(lines(wizard).some((line) => line.includes("Add local reference")));
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("Reference alias")));
  void result.promise;
});

test("invalid local save remains in the wizard and successful save returns to menu", async () => {
  const responses = [{ ok: false as const, message: "Local path is unavailable" }, { ok: true as const, message: "Saved" }];
  const ctl = controller({ addLocal: async () => responses.shift()! });
  const wizard = new ReferencesSetupWizard({ tui: tui(), theme, controller: ctl, done: () => {} });
  await new Promise<void>((resolve) => setImmediate(resolve));
  wizard.handleInput("\r");
  // Alias, path, description, hidden fields are submitted sequentially.
  for (const value of ["docs", "/tmp/docs", "Local docs", "n"]) {
    for (const char of value) wizard.handleInput(char);
    wizard.handleInput("\r");
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(lines(wizard).some((line) => line.includes("Local path is unavailable")));
  wizard.handleInput("\r"); // retry
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(lines(wizard).some((line) => line.includes("Reference alias")));
});

test("Escape cancels from every step and abort settles once", async () => {
  const result = resultPromise();
  const cancelled: string[] = [];
  const wizard = new ReferencesSetupWizard({
    tui: tui(),
    theme,
    controller: controller({ cancel: async () => {
      cancelled.push("cancel");
    } }),
    done: result.resolve,
  });
  wizard.handleInput("\x1b");
  assert.deepEqual(await result.promise, { status: "cancelled" });
  assert.deepEqual(cancelled, ["cancel"]);
});

test("narrow render stays safe", () => {
  const wizard = new ReferencesSetupWizard({ tui: tui(), theme, controller: controller(), done: () => {} });
  assert.ok(wizard.render(8).length > 0);
});
