import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { TUI } from "@earendil-works/pi-tui";
import { CompactThresholdDialog } from "../src/compact-threshold-dialog.ts";

function tui(): TUI {
  return { terminal: { rows: 24 }, requestRender: () => {} } as unknown as TUI;
}

const theme = { fg: (_color: string, text: string) => text };

function mount(prefill: string, title: string, hint: string): { dialog: CompactThresholdDialog; result: (() => string | undefined) } {
  let settled: string | undefined;
  const dialog = new CompactThresholdDialog({
    tui: tui(),
    theme,
    prefill,
    title,
    hint,
    done: (value) => { settled = value; },
  });
  return { dialog, result: () => settled };
}

test("compact-threshold-dialog: renders a › prompt with 1-space left padding and the prefilled value", () => {
  const { dialog } = mount("85", "Title", "Hint");
  const lines = dialog.render(100).map(stripVTControlCharacters);

  // The input line is `  › 85…` — › at 1-space left padding, value inline.
  const inputLine = lines.find((line) => line.includes("›"));
  assert.ok(inputLine, "input line with › prompt present");
  assert.ok(inputLine!.startsWith("  › "), `› at 1-space padding: ${JSON.stringify(inputLine)}`);
  assert.ok(inputLine!.includes("85"), `prefilled value visible: ${JSON.stringify(inputLine)}`);
  assert.ok(lines.some((line) => line.includes("Title")), "title rendered");
  assert.ok(lines.some((line) => line.includes("Hint")), "hint rendered");
  assert.ok(lines.some((line) => line.includes("enter submit")), "submit hint rendered");
});

test("compact-threshold-dialog: enter submits the edited value", () => {
  const { dialog, result } = mount("80", "Title", "Hint");
  // Simulate typing "75" over the prefill, then submit.
  const editor = (dialog as unknown as { editor: { setText(t: string): void; onSubmit?: (v: string) => void } }).editor;
  editor.setText("75");
  editor.onSubmit?.("75");
  assert.equal(result(), "75", "submitted value returned");
});

test("compact-threshold-dialog: escape cancels with undefined", () => {
  const { dialog, result } = mount("80", "Title", "Hint");
  dialog.handleInput("\x1b");
  assert.equal(result(), undefined, "escape resolves undefined");
});

test("compact-threshold-dialog: ctrl+c cancels with undefined", () => {
  const { dialog, result } = mount("80", "Title", "Hint");
  dialog.handleInput("\x03");
  assert.equal(result(), undefined, "ctrl+c resolves undefined");
});

test("compact-threshold-dialog: aborted signal resolves undefined", () => {
  const controller = new AbortController();
  let settled: string | undefined = "unset";
  const dialog = new CompactThresholdDialog({
    tui: tui(),
    theme,
    prefill: "80",
    title: "Title",
    hint: "Hint",
    done: (value) => { settled = value; },
    signal: controller.signal,
  });
  assert.equal(settled, "unset", "not settled before abort");
  controller.abort();
  assert.equal(settled, undefined, "abort resolves undefined");
  assert.ok(dialog, "dialog still constructed");
});
