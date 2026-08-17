import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { registerQuestionTool, type QuestionParams } from "../src/index.ts";
import type { QuestionDetails } from "../src/types.ts";

/**
 * Renderer tests for the `question` tool.
 *
 * The tool provides custom `renderCall`/`renderResult` components built from
 * pi-tui `Text`; these tests drive those components directly with a stub theme
 * and assert the emitted text covers the question, numbered options (including
 * the always-appended "Type something."), and the answer or cancellation state.
 */

interface Renderers {
  renderCall?: (args: QuestionParams, theme: Theme, context?: unknown) => { render(width: number): string[] };
  renderResult: (
    result: { content: Array<{ type: string; text?: string }>; details?: QuestionDetails },
    options: unknown,
    theme: Theme,
    context?: unknown,
  ) => { render(width: number): string[] };
}

interface RegisteredTool {
  renderCall?: Renderers["renderCall"];
  renderResult?: Renderers["renderResult"];
}

function captureRenderers(): Renderers {
  let tool: RegisteredTool | undefined;
  const pi = {
    registerTool(registered: RegisteredTool) {
      tool = registered;
    },
  } as unknown as Parameters<typeof registerQuestionTool>[0];
  registerQuestionTool(pi);
  assert.ok(tool?.renderResult, "question tool result renderer present");
  return { renderCall: tool.renderCall, renderResult: tool.renderResult };
}

/** Stub theme: identity functions so rendered text stays plain. */
const identity = (text: string): string => text;
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: identity,
  italic: identity,
  underline: identity,
  inverse: identity,
  strikethrough: identity,
} as unknown as Theme;

const params: QuestionParams = {
  question: "Proceed?",
  options: [
    { label: "Yes", description: "Continue" },
    { label: "No" },
  ],
};

test("question renders concise activity and exact arguments when expanded", () => {
  const { renderCall } = captureRenderers();
  assert.ok(renderCall);
  const collapsed = stripVTControlCharacters(renderCall!(params, theme).render(80).join(""));
  assert.match(collapsed, /question/);
  assert.match(collapsed, /Proceed\?/);
  assert.doesNotMatch(collapsed, /\"options\"/);
  const expanded = stripVTControlCharacters(renderCall!(params, theme, { expanded: true, args: params }).render(120).join(""));
  assert.match(expanded, /Input: question=Proceed\?, options=label=Yes, description=Continue, label=No/);
});

test("renderResult shows a selected answer only when expanded", () => {
  const { renderResult } = captureRenderers();
  const details: QuestionDetails = {
    question: "Proceed?",
    options: ["Yes", "No"],
    answer: "No",
    wasCustom: false,
    index: 2,
  };
  const collapsed = stripVTControlCharacters(renderResult({ content: [], details }, { expanded: false, isPartial: false }, theme, { isError: false }).render(80).join(""));
  const expanded = stripVTControlCharacters(renderResult({ content: [], details }, { expanded: true, isPartial: false }, theme, { expanded: true, isError: false }).render(80).join(""));
  assert.match(collapsed, /question answered/);
  assert.doesNotMatch(collapsed, /No/);
  assert.match(expanded, /No/);
});

test("renderResult shows a custom answer only when expanded", () => {
  const { renderResult } = captureRenderers();
  const details: QuestionDetails = {
    question: "Proceed?",
    options: ["Yes", "No"],
    answer: "Maybe later",
    wasCustom: true,
  };
  const collapsed = stripVTControlCharacters(renderResult({ content: [], details }, { expanded: false, isPartial: false }, theme, { isError: false }).render(80).join(""));
  const expanded = stripVTControlCharacters(renderResult({ content: [], details }, { expanded: true, isPartial: false }, theme, { expanded: true, isError: false }).render(80).join(""));
  assert.match(collapsed, /question answered/);
  assert.doesNotMatch(collapsed, /Maybe later|wrote/);
  assert.match(expanded, /Maybe later/);
});

test("renderResult shows Cancelled for a null answer", () => {
  const { renderResult } = captureRenderers();
  const details: QuestionDetails = {
    question: "Proceed?",
    options: ["Yes", "No"],
    answer: null,
  };
  const lines = stripVTControlCharacters(renderResult({ content: [], details }, { expanded: false, isPartial: false }, theme, { isError: false }).render(80).join(""));
  assert.match(lines, /question cancelled/);
});