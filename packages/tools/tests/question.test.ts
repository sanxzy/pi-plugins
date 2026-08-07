import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DISMISSED } from "@xzy-ai/tui";
import {
  questionParams,
  type QuestionParams,
  registerQuestionTool,
} from "../src/index.ts";
import type { QuestionDetails } from "../src/types.ts";

interface RegisteredTool {
  name: string;
  parameters: typeof questionParams;
  execute: (
    toolCallId: string,
    params: QuestionParams,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details: QuestionDetails }>;
}

function captureTool(): RegisteredTool {
  let registered: RegisteredTool | undefined;
  const pi = {
    registerTool(tool: RegisteredTool) {
      registered = tool;
    },
  } as unknown as ExtensionAPI;
  registerQuestionTool(pi);
  assert.ok(registered, "question tool registered");
  return registered;
}

// The host `custom` is generic over its result type; a test stub returns a
// fixed shape, so type it loosely and let the cast to ExtensionContext absorb
// the difference.
type CustomUI = (factory: unknown, options?: unknown) => Promise<unknown>;

function context(mode: ExtensionContext["mode"], custom: CustomUI): ExtensionContext {
  return { mode, ui: { custom } } as unknown as ExtensionContext;
}

const params: QuestionParams = {
  question: "Proceed?",
  options: [
    { label: "Yes", description: "Continue" },
    { label: "No" },
  ],
};

test("questionParams has the question and option schema", () => {
  assert.equal(questionParams.type, "object");
  assert.deepEqual(questionParams.required, ["question", "options"]);
  assert.equal(questionParams.properties.question.type, "string");
  assert.equal(questionParams.properties.options.type, "array");
  assert.equal(questionParams.properties.options.items.type, "object");
  assert.deepEqual(questionParams.properties.options.items.required, ["label"]);
});

test("non-TUI mode returns an error with answer null without opening UI", async () => {
  const tool = captureTool();
  let opened = false;
  const result = await tool.execute(
    "call-1",
    params,
    undefined,
    undefined,
    context("rpc", async () => {
      opened = true;
      return null;
    }),
  );
  assert.equal(opened, false);
  assert.match(result.content[0]?.text ?? "", /^Error:/);
  assert.deepEqual(result.details, {
    question: "Proceed?",
    options: ["Yes", "No"],
    answer: null,
  });
});

test("empty options returns an error with answer null without opening UI", async () => {
  const tool = captureTool();
  let opened = false;
  const result = await tool.execute(
    "call-2",
    { question: "Proceed?", options: [] },
    undefined,
    undefined,
    context("tui", async () => {
      opened = true;
      return null;
    }),
  );
  assert.equal(opened, false);
  assert.match(result.content[0]?.text ?? "", /^Error:/);
  assert.deepEqual(result.details, { question: "Proceed?", options: [], answer: null });
});

test("selected dialog result maps to a structured QuestionDetails payload", async () => {
  const tool = captureTool();
  let receivedSignal: AbortSignal | undefined;
  const result = await tool.execute(
    "call-3",
    params,
    new AbortController().signal,
    undefined,
    context("tui", async (factory, options) => {
      assert.equal(typeof factory, "function");
      assert.equal(options, undefined);
      receivedSignal = undefined;
      return { answer: "No", wasCustom: false, index: 2 };
    }),
  );
  assert.equal(receivedSignal, undefined);
  assert.deepEqual(result.details, {
    question: "Proceed?",
    options: ["Yes", "No"],
    answer: "No",
    wasCustom: false,
    index: 2,
  });
  assert.match(result.content[0]?.text ?? "", /No/);
});

test("custom dialog result maps to wasCustom true without an index", async () => {
  const tool = captureTool();
  const result = await tool.execute(
    "call-4",
    params,
    undefined,
    undefined,
    context("tui", async () => ({ answer: "Maybe later", wasCustom: true })),
  );
  assert.deepEqual(result.details, {
    question: "Proceed?",
    options: ["Yes", "No"],
    answer: "Maybe later",
    wasCustom: true,
  });
  assert.match(result.content[0]?.text ?? "", /Maybe later/);
});

test("dismissal maps to a normal result with answer null", async () => {
  const tool = captureTool();
  const result = await tool.execute(
    "call-5",
    params,
    undefined,
    undefined,
    context("tui", async () => DISMISSED),
  );
  assert.deepEqual(result.details, {
    question: "Proceed?",
    options: ["Yes", "No"],
    answer: null,
  });
  assert.doesNotMatch(result.content[0]?.text ?? "", /^Error:/);
});
