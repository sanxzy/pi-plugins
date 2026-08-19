import { Editor, Key, matchesKey, type Component, type EditorTheme, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Result of the compact-threshold input dialog: the submitted text, or undefined when cancelled. */
export type CompactThresholdDialogResult = string | undefined;

export interface CompactThresholdDialogOptions {
  readonly tui: TUI;
  readonly theme: { fg: (color: string, text: string) => string };
  /** Current threshold value pre-filled into the input. */
  readonly prefill: string;
  /** Title shown above the input. */
  readonly title: string;
  /** Hint line shown under the input. */
  readonly hint: string;
  readonly done: (result: CompactThresholdDialogResult) => void;
  readonly signal?: AbortSignal;
}

/**
 * Single-line threshold input dialog with a `› ` prompt and 1 column of left
 * padding. The input is pre-filled with the current threshold so the user can
 * see and edit it in place. Enter submits; Escape/Ctrl+C cancels.
 *
 * The component deliberately owns only presentation and input state. The
 * caller supplies `done`, so the host's `ctx.ui.custom()` remains responsible
 * for mounting and unmounting the component.
 */
export class CompactThresholdDialog implements Component {
  private readonly tui: TUI;
  private readonly theme: { fg: (color: string, text: string) => string };
  private readonly title: string;
  private readonly hint: string;
  private readonly done: (result: CompactThresholdDialogResult) => void;
  private readonly editor: Editor;

  private cachedLines: string[] | undefined;
  private settled = false;

  constructor(options: CompactThresholdDialogOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.title = options.title;
    this.hint = options.hint;
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
    // 1 column of left padding inside the input area.
    this.editor.setPaddingX(1);
    this.editor.setText(options.prefill);
    this.editor.onSubmit = (value) => {
      this.finish(value);
    };

    if (options.signal) {
      options.signal.addEventListener("abort", this.finishAbort, { once: true });
      if (options.signal.aborted) this.finishAbort();
    }
  }

  /** Resolve the dialog as cancelled when the enclosing turn is aborted. */
  private readonly finishAbort = (): void => {
    this.finish(undefined);
  };

  private finish(result: CompactThresholdDialogResult): void {
    if (this.settled) return;
    this.settled = true;
    this.done(result);
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.editor.invalidate();
  }

  handleInput(data: string): void {
    if (this.settled) return;
    // Escape or Ctrl+C cancels (matching the SDK input dialog behavior).
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.finish(undefined);
      return;
    }
    this.editor.handleInput(data);
    this.invalidate();
  }

  render(width: number): string[] {
    if (this.cachedLines) return this.cachedLines;
    const renderWidth = Math.max(1, Math.floor(width));
    const lines: string[] = [];
    const add = (prefix: string, text: string): void => {
      const prefixWidth = visibleWidth(prefix);
      const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
      const continuation = " ".repeat(prefixWidth);
      for (let i = 0; i < wrapped.length; i++) lines.push(`${i === 0 ? prefix : continuation}${wrapped[i]}`);
    };
    // 1 column of left padding, then a `› ` prompt on the input line.
    lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));
    add(" ", this.theme.fg("accent", this.title));
    add(" ", this.theme.fg("muted", this.hint));
    // The editor line carries a 4-column prefix (`  › `), so render it 4
    // columns narrower; every emitted line is truncated to renderWidth so the
    // component can never exceed the terminal width.
    const editorLines = this.editor.render(Math.max(1, renderWidth - 4));
    editorLines.forEach((line, index) => {
      const isContent = index === 1 && editorLines.length >= 3;
      const prefixed = isContent ? `  ${this.theme.fg("accent", "›")} ${line}` : `    ${line}`;
      lines.push(truncateToWidth(prefixed, renderWidth));
    });
    add(" ", this.theme.fg("dim", "enter submit  escape/ctrl+c cancel"));
    lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));
    this.cachedLines = lines;
    return lines;
  }
}
