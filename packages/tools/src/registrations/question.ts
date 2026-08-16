import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { TOOL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { DISMISSED, QuestionDialog, type QuestionDialogResult, type QuestionDialogTheme } from "@xzy-ai/tui";
import { questionParams, type QuestionParams } from "../tools.ts";
import type { QuestionDetails } from "../types.ts";
import { errorResult, textResult } from "../results.ts";
import { renderToolCall, renderToolResult, toolResultFailed } from "../render.ts";

/**
 * Register the `question` tool.
 *
 * Asks the user a single structured question during TUI execution through the
 * shared `@xzy-ai/tui` dialog. The tool is TUI-only: any other mode returns an
 * error result without opening the dialog, and an empty `options` list is
 * rejected up front. Dismissal and an aborted turn are informational — they
 * return a normal result with `answer: null`.
 */
export function registerQuestionTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "question",
    label: "Question",
    description: "Ask the user a question and let them pick from options. Use when you need user input to proceed.",
    parameters: questionParams,
    async execute(
      _toolCallId: string,
      params: QuestionParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<QuestionDetails>> {
      return processWithLog({ operation: TOOL_OPERATIONS.QUESTION_EXECUTE, parameters: { question: params.question } }, async () => {
      // The dialog owns the `@earendil-works/pi-tui` dependency inside
      // `@xzy-ai/tui`; the host Theme only needs to satisfy the `fg` surface
      // the dialog consumes here. The dialog passes a handful of fixed color
      // names, all of which are valid `ThemeColor` values.
      const dialogTheme = (theme: { fg: (color: ThemeColor, text: string) => string }): QuestionDialogTheme => ({
        borderColor: (text) => theme.fg("accent", text),
        fg: (color, text) => theme.fg(color as ThemeColor, text),
        selectList: {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        },
      });

      if (ctx.mode !== "tui") {
        return errorResult("UI not available (running in non-interactive mode)", {
          question: params.question,
          options: params.options.map((o) => o.label),
          answer: null,
        });
      }

      if (params.options.length === 0) {
        return errorResult("No options provided", {
          question: params.question,
          options: [],
          answer: null,
        });
      }

      const result = await ctx.ui.custom<QuestionDialogResult>(
        (tui, theme, _keybindings, done) =>
          new QuestionDialog({
            tui,
            question: params.question,
            options: params.options,
            theme: dialogTheme(theme),
            done,
            signal,
          }),
      );

      const options = params.options.map((o) => o.label);

      if (result === DISMISSED) {
        return textResult("User cancelled the selection", {
          question: params.question,
          options,
          answer: null,
        });
      }

      if (result.wasCustom) {
        return textResult(`User wrote: ${result.answer}`, {
          question: params.question,
          options,
          answer: result.answer,
          wasCustom: true,
        });
      }

      return textResult(`User selected: ${result.index}. ${result.answer}`, {
        question: params.question,
        options,
        answer: result.answer,
        wasCustom: false,
        index: result.index,
      });
      });
    },

    renderCall(args, theme) {
      return renderToolCall(theme, "question", args.question);
    },

    renderResult(result, options, theme, context) {
      const answer = result.details?.answer;
      const activity = toolResultFailed(result, context)
        ? "question unavailable"
        : answer === null ? "question cancelled" : answer ? "question answered" : "question complete";
      return renderToolResult(theme, activity, toolResultFailed(result, context), options.isPartial);
    },
  });
}
