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
    sendUserMessage(content: string, options?: { deliverAs: "steer" }) {
      sent.push({ content, options });
    },
  } as unknown as ExtensionAPI;
  registerGoalCommand(pi);
  return { pi, command, sent };
}

test("registerGoalCommand registers a single current-session /goal command", () => {
  const { command } = registrations();
  assert.equal(command?.name, "goal");
});

test("the workflow describes a self-managed goal and separates leading interval metadata", () => {
  assert.doesNotMatch(GOAL_WORKFLOW_PROMPT, /main host/i);
  assert.match(GOAL_WORKFLOW_PROMPT, /current session/i);
  assert.match(GOAL_WORKFLOW_PROMPT, /your own persistent goal/i);
  assert.match(GOAL_WORKFLOW_PROMPT, /duration.*interval|interval.*duration/i);
  assert.match(GOAL_WORKFLOW_PROMPT, /remaining text.*prompt|prompt.*remaining text/i);
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

test("the workflow tells the model to separate a leading interval from the exact goal prompt", () => {
  assert.match(GOAL_WORKFLOW_PROMPT, /leading.*duration|duration.*leading/i);
  assert.match(GOAL_WORKFLOW_PROMPT, /remove.*interval|interval.*remove/i);
  assert.match(GOAL_WORKFLOW_PROMPT, /remaining.*exact.*prompt|exact.*prompt.*remaining/i);
});

test("/goal forwards an interval-prefixed request verbatim for model interpretation", () => {
  const { command, sent } = registrations();
  const request = "2m testing goal, is it working, clear after 2nd triggered";
  command!.handler(request, {} as unknown as ExtensionCommandContext);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, `${GOAL_WORKFLOW_PROMPT}\n\n${request}`);
});

test("/goal returns the logging promise so delivery failures reach the command caller", async () => {
  const { command } = registrations();
  const failing = registrations();
  failing.pi.sendUserMessage = (() => {
    throw new Error("delivery failed");
  }) as ExtensionAPI["sendUserMessage"];
  await assert.rejects(
    () => failing.command!.handler("ship it", {} as unknown as ExtensionCommandContext),
    /delivery failed/,
  );
  assert.ok(command);
});
