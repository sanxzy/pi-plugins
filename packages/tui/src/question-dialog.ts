import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  type Component,
  type TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

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
  theme: QuestionDialogTheme;
  done: (result: QuestionDialogResult) => void;
  signal?: AbortSignal;
}

type DisplayOption = QuestionOption & { isOther?: boolean };

/**
 * Theme surface the dialog needs: the coding-agent `Theme` (`fg`) plus the
 * `EditorTheme` pieces passed through to the embedded Editor.
 */
export type QuestionDialogTheme = EditorTheme & {
  fg: (color: string, text: string) => string;
};

/**
 * Interactive single-question selector used by the question tool.
 *
 * The component deliberately owns only presentation and input state. The
 * caller supplies `done`, so the host's `ctx.ui.custom()` remains responsible
 * for mounting and unmounting the component.
 */
export class QuestionDialog implements Component {
  private readonly tui: TUI;
  private readonly question: string;
  private readonly options: DisplayOption[];
  private readonly theme: QuestionDialogTheme;
  private readonly done: (result: QuestionDialogResult) => void;
  private readonly editor: Editor;

  private optionIndex = 0;
  private editMode = false;
  private cachedLines: string[] | undefined;
  private settled = false;

  constructor(options: QuestionDialogOptions) {
    this.tui = options.tui;
    this.question = options.question;
    this.options = [...options.options, { label: "Type something.", isOther: true }];
    this.theme = options.theme;
    this.done = options.done;

    const editorTheme: EditorTheme = {
      borderColor: (text) => this.theme.fg("accent", text),
      selectList: {
        selectedPrefix: (text) => this.theme.fg("accent", text),
        selectedText: (text) => this.theme.fg("accent", text),
        description: (text) => this.theme.fg("muted", text),
        scrollInfo: (text) => this.theme.fg("dim", text),
        noMatch: (text) => this.theme.fg("warning", text),
      },
    };
    this.editor = new Editor(this.tui, editorTheme);
    this.editor.onSubmit = (value) => {
      const answer = value.trim();
      if (!answer) {
        this.editMode = false;
        this.editor.setText("");
        this.refresh();
        return;
      }
      this.finish({ answer, wasCustom: true });
    };

    if (options.signal) {
      options.signal.addEventListener("abort", this.finishAbort, { once: true });
      if (options.signal.aborted) this.finishAbort();
    }
  }

  /** Resolve the dialog as dismissed when the enclosing turn is aborted. */
  private readonly finishAbort = (): void => {
    this.finish(DISMISSED);
  };

  render(width: number): string[] {
    if (this.cachedLines) return this.cachedLines;

    const renderWidth = Math.max(1, Math.floor(width));
    const lines: string[] = [];

    const addWrapped = (text: string): void => {
      lines.push(...wrapTextWithAnsi(text, renderWidth));
    };

    const addWrappedWithPrefix = (prefix: string, text: string): void => {
      const prefixWidth = visibleWidth(prefix);
      if (prefixWidth >= renderWidth) {
        // Keep every output line within the viewport even for very narrow
        // widths; the full text is still rendered on wrapped continuation lines.
        addWrapped(text);
        return;
      }
      const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
      const continuationPrefix = " ".repeat(prefixWidth);
      for (let i = 0; i < wrapped.length; i++) {
        lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
      }
    };

    lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));
    addWrappedWithPrefix(" ", this.theme.fg("text", this.question));
    lines.push("");

    for (let i = 0; i < this.options.length; i++) {
      const option = this.options[i]!;
      const selected = i === this.optionIndex;
      const isOther = option.isOther === true;
      const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
      const label = `${i + 1}. ${option.label}${isOther && this.editMode ? " ✎" : ""}`;
      const color = selected || (isOther && this.editMode) ? "accent" : "text";

      addWrappedWithPrefix(prefix, this.theme.fg(color, label));
      if (option.description) {
        addWrappedWithPrefix("     ", this.theme.fg("muted", option.description));
      }
    }

    if (this.editMode) {
      lines.push("");
      addWrappedWithPrefix(" ", this.theme.fg("muted", "Your answer:"));
      for (const line of this.editor.render(Math.max(1, renderWidth - 2))) {
        // The editor reserves its own width; the leading space preserves the
        // same indentation as the question and remains inside the viewport.
        const editorLine = ` ${line}`;
        if (visibleWidth(editorLine) <= renderWidth) {
          lines.push(editorLine);
        } else {
          lines.push(...wrapTextWithAnsi(editorLine, renderWidth));
        }
      }
    }

    lines.push("");
    const help = this.editMode
      ? "Enter to submit • Esc to go back"
      : "↑↓ navigate • Enter to select • Esc to cancel";
    addWrappedWithPrefix(" ", this.theme.fg("dim", help));
    lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));

    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.editor.invalidate();
  }

  handleInput(data: string): void {
    if (this.settled) return;

    if (this.editMode) {
      if (matchesKey(data, Key.escape)) {
        this.editMode = false;
        this.editor.setText("");
        this.refresh();
        return;
      }
      this.editor.handleInput(data);
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.optionIndex = Math.max(0, this.optionIndex - 1);
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.optionIndex = Math.min(this.options.length - 1, this.optionIndex + 1);
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const selected = this.options[this.optionIndex]!;
      if (selected.isOther) {
        this.editMode = true;
        this.editor.setText("");
        this.refresh();
      } else {
        this.finish({ answer: selected.label, wasCustom: false, index: this.optionIndex + 1 });
      }
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.finish(DISMISSED);
    }
  }

  private refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  private finish(result: QuestionDialogResult): void {
    if (this.settled) return;
    this.settled = true;
    this.done(result);
  }
}
