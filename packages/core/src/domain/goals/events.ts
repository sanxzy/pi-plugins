import type { Goal } from "./record.ts";
import { createGoalRecord, pauseGoalRecord, resumeGoalRecord } from "./record.ts";

/**
 * Append-only goal events.
 *
 * Each event is a single immutable record appended to the project goal log.
 * The goal store is the single writer; events are never modified or reordered.
 * A reader folds the log per cwd into the current goal state.
 */

export type GoalEvent =
  | { event: "goal_created"; cwd: string; goalId: string; timestamp: number; prompt: string; intervalMs: number }
  | { event: "goal_paused"; cwd: string; goalId: string; timestamp: number; reason: string }
  | { event: "goal_resumed"; cwd: string; goalId: string; timestamp: number }
  | { event: "goal_cleared"; cwd: string; goalId: string; timestamp: number };

/** Serialize a goal event to a single JSONL line. */
export function serializeGoalEvent(event: GoalEvent): string {
  return JSON.stringify(event);
}

/** Parse a single goal JSONL line back into an event, or null when malformed. */
export function parseGoalEvent(line: string): GoalEvent | null {
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as GoalEvent;
    if (parsed && typeof parsed.event === "string") return parsed;
  } catch {
    // Malformed line: skip it and keep the rest of the log intact.
  }
  return null;
}

/**
 * Fold a sequence of goal events into the current per-cwd goal state.
 *
 * Folding is keyed by normalized cwd: each cwd holds at most one current goal,
 * and clearing a goal removes its record. Events for a cwd are applied in order,
 * so the last write wins and a fresh reader reconstructs the same state.
 */
export function foldGoalEvents(events: Iterable<GoalEvent>): Map<string, Goal> {
  const result = new Map<string, Goal>();
  for (const event of events) {
    const current = result.get(event.cwd);
    switch (event.event) {
      case "goal_created": {
        result.set(event.cwd, createGoalRecord({
          goalId: event.goalId,
          cwd: event.cwd,
          prompt: event.prompt,
          intervalMs: event.intervalMs,
          timestamp: event.timestamp,
        }));
        break;
      }
      case "goal_paused": {
        if (current) result.set(event.cwd, pauseGoalRecord(current, event.reason, event.timestamp));
        break;
      }
      case "goal_resumed": {
        if (current) result.set(event.cwd, resumeGoalRecord(current, event.timestamp));
        break;
      }
      case "goal_cleared": {
        result.delete(event.cwd);
        break;
      }
    }
  }
  return result;
}