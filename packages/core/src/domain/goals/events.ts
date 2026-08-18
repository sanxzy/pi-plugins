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
  | { event: "goal_created"; cwd: string; rootSessionId: string; goalId: string; timestamp: number; prompt: string; intervalMs: number }
  | { event: "goal_paused"; cwd: string; rootSessionId: string; goalId: string; timestamp: number; reason: string }
  | { event: "goal_resumed"; cwd: string; rootSessionId: string; goalId: string; timestamp: number }
  | { event: "goal_cleared"; cwd: string; rootSessionId: string; goalId: string; timestamp: number };

/** Serialize a goal event to a single JSONL line. */
export function serializeGoalEvent(event: GoalEvent): string {
  return JSON.stringify(event);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isValidGoalEvent(parsed: unknown): parsed is GoalEvent {
  if (typeof parsed !== "object" || parsed === null) return false;
  const event = parsed as Record<string, unknown>;
  if (!isNonEmptyString(event.cwd) || !isNonEmptyString(event.rootSessionId) || !isNonEmptyString(event.goalId) || !isPositiveSafeInteger(event.timestamp)) {
    return false;
  }
  switch (event.event) {
    case "goal_created":
      return isNonEmptyString(event.prompt) && isPositiveSafeInteger(event.intervalMs);
    case "goal_paused":
      return isNonEmptyString(event.reason);
    case "goal_resumed":
    case "goal_cleared":
      return true;
    default:
      return false;
  }
}

/** Parse a single goal JSONL line back into an event, or null when malformed. */
export function parseGoalEvent(line: string): GoalEvent | null {
  if (!line) return null;
  try {
    const parsed = JSON.parse(line);
    if (isValidGoalEvent(parsed)) return parsed;
  } catch {
    // Malformed line: skip it and keep the rest of the log intact.
  }
  return null;
}

/**
 * Fold a sequence of goal events into the current per-session goal state.
 *
 * Folding is keyed by rootSessionId: each root session holds at most one
 * current goal, and clearing a goal removes its record. Events are applied in
 * order, so the last write wins and a fresh reader reconstructs the same state.
 */
export function foldGoalEvents(events: Iterable<GoalEvent>): Map<string, Goal> {
  const result = new Map<string, Goal>();
  for (const event of events) {
    const current = result.get(event.rootSessionId);
    switch (event.event) {
      case "goal_created": {
        result.set(event.rootSessionId, createGoalRecord({
          goalId: event.goalId,
          rootSessionId: event.rootSessionId,
          cwd: event.cwd,
          prompt: event.prompt,
          intervalMs: event.intervalMs,
          timestamp: event.timestamp,
        }));
        break;
      }
      case "goal_paused": {
        if (current && current.goalId === event.goalId) {
          result.set(event.rootSessionId, pauseGoalRecord(current, event.reason, event.timestamp));
        }
        break;
      }
      case "goal_resumed": {
        if (current && current.goalId === event.goalId) {
          result.set(event.rootSessionId, resumeGoalRecord(current, event.timestamp));
        }
        break;
      }
      case "goal_cleared": {
        if (current?.goalId === event.goalId) result.delete(event.rootSessionId);
        break;
      }
    }
  }
  return result;
}