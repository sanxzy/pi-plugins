import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  foldGoalEvents,
  parseGoalEvent,
  serializeGoalEvent,
  type Goal,
  type GoalEvent,
} from "@xzy-ai/core";
import { PERSISTENCE_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { goalsFile } from "../../shared/paths.ts";

/**
 * Append-only per-cwd goal store.
 *
 * The store is the single writer of goal events. Each event is appended to
 * `goals.jsonl`; readers fold the log per cwd into the current goal record.
 * The log is never rewritten, so a fresh reader reconstructs the same state.
 */
export interface GoalStore {
  readonly filePath: string;
  /** Append a goal event and refresh the in-memory index. */
  append(event: GoalEvent): void;
  /** Create a goal for a cwd; rejects when an active or paused goal exists. */
  create(input: {
    cwd: string;
    prompt: string;
    intervalMs: number;
  }): { readonly ok: true; readonly goal: Goal } | { readonly ok: false; readonly error: string };
  /** Pause a cwd goal with an exact reason. */
  pause(cwd: string, reason: string): { readonly ok: true; readonly goal: Goal } | { readonly ok: false; readonly error: string };
  /** Resume a paused cwd goal. */
  resume(cwd: string): { readonly ok: true; readonly goal: Goal } | { readonly ok: false; readonly error: string };
  /** Return the current cwd goal, or undefined when none exists. */
  get(cwd: string): Goal | undefined;
  /** Remove the cwd goal so a later creation is allowed. */
  clear(cwd: string): boolean;
  /** Fold the log fresh and return every current goal keyed by cwd. */
  fold(): Map<string, Goal>;
}

/** Fold a goal JSONL log into the current per-cwd goal state. */
export function foldGoalLog(filePath: string): Map<string, Goal> {
  if (!existsSync(filePath)) return new Map();
  const lines = readFileSync(filePath, "utf-8").split("\n");
  const events: GoalEvent[] = [];
  for (const line of lines) {
    const event = parseGoalEvent(line);
    if (event) events.push(event);
  }
  return foldGoalEvents(events);
}

export function createGoalStore(filePath: string): GoalStore {
  let index = foldGoalLog(filePath);

  const append = (event: GoalEvent): void => {
    processWithLog({ operation: PERSISTENCE_OPERATIONS.GOAL_APPEND, parameters: { event: event.event, cwd: event.cwd } }, () => {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, `${serializeGoalEvent(event)}\n`, { flag: "a" });
      index = foldGoalLog(filePath);
    });
  };

  return {
    filePath,
    append,
    create({ cwd, prompt, intervalMs }) {
      if (index.has(cwd)) {
        return { ok: false, error: "a goal already exists for this cwd; clear it first" };
      }
      const goalId = randomUUID();
      const timestamp = Date.now();
      append({ event: "goal_created", cwd, goalId, timestamp, prompt, intervalMs });
      return { ok: true, goal: index.get(cwd)! };
    },
    pause(cwd, reason) {
      const current = index.get(cwd);
      if (!current) return { ok: false, error: "no goal exists for this cwd" };
      append({ event: "goal_paused", cwd, goalId: current.goalId, timestamp: Date.now(), reason });
      return { ok: true, goal: index.get(cwd)! };
    },
    resume(cwd) {
      const current = index.get(cwd);
      if (!current) return { ok: false, error: "no goal exists for this cwd" };
      append({ event: "goal_resumed", cwd, goalId: current.goalId, timestamp: Date.now() });
      return { ok: true, goal: index.get(cwd)! };
    },
    get(cwd) {
      return index.get(cwd);
    },
    clear(cwd) {
      const current = index.get(cwd);
      if (!current) return false;
      append({ event: "goal_cleared", cwd, goalId: current.goalId, timestamp: Date.now() });
      return true;
    },
    fold() {
      index = foldGoalLog(filePath);
      return index;
    },
  };
}

export { goalsFile };