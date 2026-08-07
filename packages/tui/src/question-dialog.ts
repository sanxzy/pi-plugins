import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";

/** Sentinel returned when the dialog is dismissed (Escape or aborted turn). */
export const DISMISSED = Symbol("question-dialog-dismissed");

/** A single selectable option shown in the dialog. */
export interface QuestionOption {
  label: string;
  description?: string;
}

/**
 * Result of an answered dialog. Either a selection (`wasCustom: false`,
 * `index` is the 1-based display position) or a custom answer
 * (`wasCustom: true`).
 */
export type QuestionDialogResult =
  | { answer: string; wasCustom: boolean; index?: number }
  | typeof DISMISSED;

export interface QuestionDialogOptions {
  tui: TUI;
  question: string;
  options: QuestionOption[];
  theme: EditorTheme;
  done: (result: QuestionDialogResult) => void;
  signal?: AbortSignal;
}

export class QuestionDialog implements Component {
  constructor(_options: QuestionDialogOptions) {
    throw new Error("not implemented");
  }

  render(_width: number): string[] {
    throw new Error("not implemented");
  }

  invalidate(): void {
    throw new Error("not implemented");
  }

  handleInput(_data: string): void {
    throw new Error("not implemented");
  }
}