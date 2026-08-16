import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerGoalCommand, GOAL_WORKFLOW_PROMPT } from "../src/registrations/goal-command.ts";

interface RegisteredCommand {
  name: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
}

interface HiddenMessage {
  customType: string;
  content: string;
  display: boolean;
}

function registrations(): { pi: ExtensionAPI; command?: RegisteredCommand; sent: Array<{ content: string; options: unknown }>; hidden: Array<{ message: HiddenMessage; options: unknown }> } {
  const sent: Array<{ content: string; options: unknown }> = [];
  const hidden: Array<{ message: HiddenMessage; options: unknown }> = [];
  let command: RegisteredCommand | undefined;
  const pi = {
    registerCommand(name: string, options: Omit<RegisteredCommand, "name">) {
      command = { name, handler: options.handler };
    },
    sendUserMessage(content: string, options?: { deliverAs: "steer" }) {
      sent.push({ content, options });
    },
    sendMessage(message: HiddenMessage, options?: unknown) {
      hidden.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  registerGoalCommand(pi);
  return { pi, command, sent, hidden };
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
  assert.match(GOAL_WORKFLOW_PROMPT, /clear the goal only when it is actually complete/i);
  assert.doesNotMatch(GOAL_WORKFLOW_PROMPT, /goal_clear.*isComplete/i);
  assert.match(GOAL_WORKFLOW_PROMPT, /Prompt:\s*$/);
});

test("registerGoalCommand forwards the workflow prompt and exact text as hidden steer context", () => {
  const { command, sent, hidden } = registrations();
  const ctx = { cwd: "/project" } as unknown as ExtensionCommandContext;
  const text = "  ship the plugin  ";
  command!.handler(text, ctx);
  assert.equal(sent.length, 0);
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].message.content, `${GOAL_WORKFLOW_PROMPT}\n\n${text}`);
  assert.equal(hidden[0].message.customType, "pi-c2:goal-workflow");
  assert.equal(hidden[0].message.display, false);
  assert.deepEqual(hidden[0].options, { triggerTurn: true, deliverAs: "steer" });
});

test("a /goal with no text asks the model to propose next steps in hidden context", () => {
  const { command, sent, hidden } = registrations();
  command!.handler("", {} as unknown as ExtensionCommandContext);
  assert.equal(sent.length, 0);
  assert.equal(hidden.length, 1);
  assert.match(hidden[0].message.content, /propose next steps/i);
  assert.equal(hidden[0].message.display, false);
  assert.deepEqual(hidden[0].options, { triggerTurn: true, deliverAs: "steer" });
});

test("the workflow tells the model to separate a leading interval from the exact goal prompt", () => {
  assert.match(GOAL_WORKFLOW_PROMPT, /leading.*duration|duration.*leading/i);
  assert.match(GOAL_WORKFLOW_PROMPT, /remove.*interval|interval.*remove/i);
  assert.match(GOAL_WORKFLOW_PROMPT, /remaining.*exact.*prompt|exact.*prompt.*remaining/i);
});

test("/goal forwards an interval-prefixed request verbatim for model interpretation", () => {
  const { command, sent, hidden } = registrations();
  const request = "2m testing goal, is it working, clear after 2nd triggered";
  command!.handler(request, {} as unknown as ExtensionCommandContext);
  assert.equal(sent.length, 0);
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].message.content, `${GOAL_WORKFLOW_PROMPT}\n\n${request}`);
  assert.equal(hidden[0].message.display, false);
});

test("/goal returns the logging promise so delivery failures reach the command caller", async () => {
  const { command } = registrations();
  const failing = registrations();
  failing.pi.sendMessage = (() => {
    throw new Error("delivery failed");
  }) as ExtensionAPI["sendMessage"];
  await assert.rejects(
    () => failing.command!.handler("ship it", {} as unknown as ExtensionCommandContext),
    /delivery failed/,
  );
  assert.ok(command);
});
