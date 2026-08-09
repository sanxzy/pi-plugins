import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export const GOAL_WORKFLOW_PROMPT = [
  "You are managing a persistent goal for the main host's current working directory.",
  "A goal is an exact user-provided prompt delivered repeatedly until you decide it is complete or blocked.",
  "Use only these main-host tools:",
  "- goal_create({ prompt, interval? }): create an active goal; pass the user's goal text verbatim and use an interval such as 30s, 10m, 2h, or 1d.",
  "- goal_pause({ reason }): pause a blocked goal with the exact non-empty reason.",
  "- goal_resume({}): resume a paused goal.",
  "- goal_status({}): inspect the full current goal record.",
  "- goal_clear({}): clear the goal when you decide it is complete or no longer relevant.",
  "The model decides when to create, pause, resume, or clear a goal. Do not rewrite or summarize the user's goal prompt. If a goal already exists, inspect it and clear it before intentionally replacing it.",
  "If the user supplies text after /goal, treat that exact text as the proposed goal request and decide which goal tool to use. If /goal has no text, propose next steps without directly mutating goal state.",
].join("\n");

export function registerGoalCommand(pi: ExtensionAPI): void {
  pi.registerCommand("goal", {
    description: "Teach the host model the persistent goal workflow.",
    async handler(args: string, _ctx: ExtensionCommandContext): Promise<void> {
      const suffix = args.length > 0
        ? `\n\n${args}`
        : "\n\nNo goal text was provided. Propose sensible next steps for the user without directly mutating goal state.";
      pi.sendUserMessage(`${GOAL_WORKFLOW_PROMPT}${suffix}`, { deliverAs: "steer" });
    },
  });
}
