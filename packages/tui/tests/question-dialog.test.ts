import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { TUI } from "@earendil-works/pi-tui";
import {
  DISMISSED,
  QuestionDialog,
  type QuestionDialogResult,
  type QuestionOption,
} from "../src/question-dialog.ts";
import { textTheme } from "./test-theme.ts";

/** Minimal TUI-shaped object the dialog needs: `terminal.rows` + `requestRender`. */
function fakeTUI(rows = 24): TUI {
  return {
    terminal: { rows },
    requestRender: () => {},
  } as unknown as TUI;
}

const OPTIONS: QuestionOption[] = [
  { label: "Continue" },
  { label: "Cancel", description: "Stop the current run" },
];

function makeDialog(overwrite: Partial<ConstructorParameters<typeof QuestionDialog>[0]> = {}) {
  const tui = fakeTUI();
  const dialog = new QuestionDialog({
    tui,
    question: "What should we do?",
    options: OPTIONS,
    theme: textTheme,
    done: () => {},
    ...overwrite,
  });
  return { tui, dialog };
}

function dirtyLines(dialog: QuestionDialog, width = 40): string[] {
  return stripVTControlCharacters(dialog.render(width).join("\n"))
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

function collectResult(): { result: unknown; resolve: (r: unknown) => void } {
  let resolve: (r: unknown) => void = () => {};
  const promise = new Promise<unknown>((r) => {
    resolve = r;
  });
  return { result: promise, resolve };
}

test("renders the question, numbered options, and the Type something entry within the width", () => {
  const { dialog } = makeDialog();
  const lines = dirtyLines(dialog, 40);
  assert.ok(lines.some((l) => l.includes("What should we do?")), "question is rendered");
  assert.ok(lines.some((l) => l.includes("1. Continue")), "first option is rendered numbered");
  assert.ok(lines.some((l) => l.includes("2. Cancel")), "second option is rendered numbered");
  assert.ok(lines.some((l) => l.includes("3. Type something.")), "Type something entry is rendered");
  assert.ok(
    lines.some((l) => l.includes("Stop the current run")),
    "option description is rendered",
  );
});

test("up/down navigation moves the selection through the options", () => {
  const { dialog } = makeDialog();
  dialog.handleInput("\x1b[B"); // down -> option 2
  let lines = dirtyLines(dialog, 40);
  assert.ok(lines.some((l) => l.includes("> 2. Cancel")), "selection moved to second option");
  dialog.handleInput("\x1b[A"); // up -> option 1
  lines = dirtyLines(dialog, 40);
  assert.ok(lines.some((l) => l.includes("> 1. Continue")), "selection moved back to first option");
});

test("numpad navigation moves the selection in arrow and keypad modes", () => {
  const { dialog } = makeDialog();

  // Application keypad mode (Num Lock off) and numeric keypad mode (Num Lock on).
  dialog.handleInput("\x1bOr"); // numpad 2 -> option 2
  let lines = dirtyLines(dialog, 40);
  assert.ok(lines.some((l) => l.includes("> 2. Cancel")), "application numpad down moved selection");

  dialog.handleInput("8"); // numpad 8 with Num Lock on -> option 1
  lines = dirtyLines(dialog, 40);
  assert.ok(lines.some((l) => l.includes("> 1. Continue")), "numeric numpad up moved selection");

  dialog.handleInput("\x1bOx"); // application numpad 8 -> remains at option 1
  lines = dirtyLines(dialog, 40);
  assert.ok(lines.some((l) => l.includes("> 1. Continue")), "application numpad up moved selection");

  dialog.handleInput("2"); // numeric numpad 2 -> option 2
  lines = dirtyLines(dialog, 40);
  assert.ok(lines.some((l) => l.includes("> 2. Cancel")), "numeric numpad down moved selection");
});

test("Enter on an option resolves with the label and its display position", async () => {
  const { result, resolve } = collectResult();
  const { dialog } = makeDialog({ done: resolve });
  dialog.handleInput("\x1b[B"); // select option 2
  dialog.handleInput("\r"); // enter
  const value = (await result) as Exclude<QuestionDialogResult, typeof DISMISSED>;
  assert.equal(value.answer, "Cancel", "selected label returned");
  assert.equal(value.wasCustom, false, "selection is not custom");
  assert.equal(value.index, 2, "display position is 1-based");
});

test("Enter on the Type something entry opens the inline editor", async () => {
  const { result, resolve } = collectResult();
  const { dialog } = makeDialog({ done: resolve });
  dialog.handleInput("\x1b[B"); // option 2
  dialog.handleInput("\x1b[B"); // option 3 (Type something)
  dialog.handleInput("\r"); // enter
  const lines = dirtyLines(dialog, 40);
  assert.ok(lines.some((l) => l.includes("Your answer:")), "inline editor is shown");
});

test("editor Enter resolves with the trimmed custom answer", async () => {
  const { result, resolve } = collectResult();
  const { dialog } = makeDialog({ done: resolve });
  dialog.handleInput("\x1b[B"); // option 2
  dialog.handleInput("\x1b[B"); // option 3 (Type something)
  dialog.handleInput("\r"); // enter -> editor
  dialog.handleInput("  hello  ");
  dialog.handleInput("\r"); // submit
  const value = (await result) as Exclude<QuestionDialogResult, typeof DISMISSED>;
  assert.equal(value.wasCustom, true, "custom answer returned");
  assert.equal(value.answer, "hello", "custom answer is trimmed");
});

test("editor Escape returns to the options list", async () => {
  const { result, resolve } = collectResult();
  const { dialog } = makeDialog({ done: resolve });
  dialog.handleInput("\x1b[B"); // option 2
  dialog.handleInput("\x1b[B"); // option 3 (Type something)
  dialog.handleInput("\r"); // enter -> editor
  dialog.handleInput("hello");
  dialog.handleInput("\x1b"); // escape -> back to options
  dialog.handleInput("\r"); // enter again -> selects Type something and opens the editor again
  const lines = dirtyLines(dialog, 40);
  assert.ok(lines.some((l) => l.includes("Your answer:")), "editor reopens after escape returns to options");
});

test("Escape in the options list resolves as dismissed", async () => {
  const { result, resolve } = collectResult();
  const { dialog } = makeDialog({ done: resolve });
  dialog.handleInput("\x1b"); // escape
  const value = (await result) as QuestionDialogResult;
  assert.equal(value, DISMISSED, "escape produces the dismissal sentinel");
  void result;
});

test("invalidate clears cached render lines", () => {
  const { dialog } = makeDialog();
  const first = dialog.render(40);
  dialog.invalidate();
  const second = dialog.render(40);
  assert.notEqual(first, second, "a fresh render is produced after invalidate");
});

test("an aborted signal resolves the dialog as dismissed", async () => {
  const { result, resolve } = collectResult();
  const controller = new AbortController();
  makeDialog({ done: resolve, signal: controller.signal });
  controller.abort();
  const value = (await result) as QuestionDialogResult;
  assert.equal(value, DISMISSED, "abort resolves as dismissed");
});

test("editing the editor requests a re-render", () => {
  const renders: number[] = [];
  const tui = { terminal: { rows: 24 }, requestRender: () => renders.push(1) } as unknown as TUI;
  const dialog = new QuestionDialog({
    tui,
    question: "q",
    options: [{ label: "a" }, { label: "b" }],
    theme: textTheme,
    done: () => {},
  });
  dialog.handleInput("\x1b[B"); // down
  dialog.handleInput("\x1b[B"); // type something
  dialog.handleInput("\r"); // editor
  const before = renders.length;
  dialog.handleInput("x");
  assert.ok(renders.length > before, "typing in the editor requests a re-render");
});