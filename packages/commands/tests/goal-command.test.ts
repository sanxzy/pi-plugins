import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerGoalCommand, GOAL_WORKFLOW_PROMPT } from "../src/registrations/goal-command.ts";

interface RegisteredCommand {
  name: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
}

function registrations(): { pi: ExtensionAPI; command?: RegisteredCommand; sent: Array<{ content: string; options: unknown }> } {
  const sent: Array<{ content: string; options: unknown }> = [];
  let command: RegisteredCommand | undefined;
  const pi = {
    registerCommand(name: string, options: Omit<RegisteredCommand, "name">) {
      command = { name, handler: options.handler };
    },
    sendUserMessage(content: string, options?: { deliverAs: "steer" | "followUp" }) {
      sent.push({ content, options });
    },
  } as unknown as ExtensionAPI;
  registerGoalCommand(pi);
  return { pi, command, sent };
}

test("registerGoalCommand registers a single main-host /goal command", () => {
  const { command } = registrations();
  assert.equal(command?.name, "goal");
});

test("registerGoalCommand forwards the workflow prompt and exact text as a steer", () => {
  const { command, sent } = registrations();
  const ctx = { cwd: "/project" } as unknown as ExtensionCommandContext;
  const text = "  ship the plugin  ";
  command!.handler(text, ctx);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, `${GOAL_WORKFLOW_PROMPT}\n\n${text}`);
  assert.deepEqual(sent[0].options, { deliverAs: "steer" });
});

test("a /goal with no text asks the model to propose next steps", () => {
  const { command, sent } = registrations();
  command!.handler("", {} as unknown as ExtensionCommandContext);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /propose next steps/i);
  assert.deepEqual(sent[0].options, { deliverAs: "steer" });
});