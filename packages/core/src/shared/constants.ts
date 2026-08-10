/**
 * Reference constants for the subagent orchestrator.
 *
 * These mirror the constants used by the PI reference subagent extension
 * (references/pi/packages/coding-agent/examples/extensions/subagent/index.ts):
 * at most `MAX_CONCURRENCY` child sessions run at once, and a single model
 * response may issue at most `MAX_PARALLEL_AGENTS` agent calls.
 */
export const MAX_CONCURRENCY = 2;
export const MAX_PARALLEL_AGENTS = 3;

/**
 * Fixed footer appended to every active-goal delivery.
 *
 * The goal system persists only the exact user prompt and appends this footer
 * at delivery time. It tells the host model how to clear the goal when the work
 * is done or no longer relevant.
 */
export const GOAL_DELIVERY_FOOTER = [
  "---",
  "If this message is no longer relevant or the goal has been completed, run the `goal_clear` tool.",
  "---",
].join("\n");
