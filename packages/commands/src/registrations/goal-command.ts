import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { COMMAND_OPERATIONS, processWithLog } from "@xzy-ai/observability";

export const GOAL_WORKFLOW_MESSAGE_TYPE = "pi-c2:goal-workflow";

export const GOAL_WORKFLOW_PROMPT = [
  "You are managing your own persistent goal for the current session.",
  "A goal is your exact user-provided prompt delivered repeatedly until you decide it is complete or blocked.",
  "Use these goal tools to create an active goal for this session. Pass the goal text verbatim and use an interval such as 30s, 10m, 2h, or 1d. Pause a blocked goal with the exact non-empty reason. Resume a paused goal. Inspect the full current goal record. Clear the goal only when it is actually complete. If the request starts with a simple duration such as 2m, treat that leading duration as interval metadata: pass it as interval and remove it from the prompt. The remaining text is the exact goal prompt. Persist and deliver only that exact prompt; do not include the interval in the prompt. I decide when to create, pause, resume, or clear my goal. Do not rewrite or summarize the user's goal prompt. If a goal already exists, inspect it and clear it before intentionally replacing it. If the user supplies text after /c2-goal, treat that exact text as the proposed goal request and decide which goal tool to use. If /c2-goal has no text, propose next steps without directly mutating goal state.",
  "",
  "Prompt:",
].join("\n");

/** Inject the workflow into model context without rendering its internal instructions in the TUI. */
export function sendHiddenGoalWorkflow(pi: ExtensionAPI, content: string): void {
  pi.sendMessage(
    { customType: GOAL_WORKFLOW_MESSAGE_TYPE, content, display: false },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

/**
 * Build the goal workflow message for a command invocation. Shared by the TUI
 * `/c2-goal` handler and the Telegram command bridge so both dispatch the exact
 * same content.
 */
export function expandTelegramGoalCommand(args: string): string {
  const suffix = args.length > 0
    ? `\n\n${args}`
    : "\n\nNo goal text was provided. Propose sensible next steps for the user without directly mutating goal state.";
  return `${GOAL_WORKFLOW_PROMPT}${suffix}`;
}

export function registerGoalCommand(pi: ExtensionAPI): void {
  pi.registerCommand("c2-goal", {
    description: "Teach the current session the persistent goal workflow.",
    async handler(args: string, _ctx: ExtensionCommandContext): Promise<void> {
      return processWithLog({ operation: COMMAND_OPERATIONS.GOAL_COMMAND, parameters: { hasArgs: args.length > 0 } }, async () => {
        sendHiddenGoalWorkflow(pi, expandTelegramGoalCommand(args));
      });
    },
  });
}
