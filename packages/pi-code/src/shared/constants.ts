/**
 * Reference constants for the subagent orchestrator.
 *
 * These mirror the constants used by the PI reference subagent extension
 * (references/pi/packages/coding-agent/examples/extensions/subagent/index.ts):
 * at most `MAX_CONCURRENCY` child sessions run at once, and a single model
 * response may issue at most `MAX_PARALLEL_TASKS` task calls.
 */
export const MAX_CONCURRENCY = 4;
export const MAX_PARALLEL_TASKS = 8;