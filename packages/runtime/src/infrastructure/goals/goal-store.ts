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
 * Append-only goal store for one root session.
 *
 * The store is the single writer of goal events for its session. Each event is
 * appended to the session's `goals.jsonl`; readers fold the log into the
 * session goal record. The log is never rewritten, so a fresh reader
 * reconstructs the same state.
 */
export interface GoalStore {
  readonly filePath: string;
  readonly rootSessionId: string;
  /** Append a goal event and refresh the in-memory index. */
  append(event: GoalEvent): void;
  /** Create the session goal; rejects when an active or paused goal exists. */
  create(input: {
    cwd: string;
    prompt: string;
    intervalMs: number;
  }): { readonly ok: true; readonly goal: Goal } | { readonly ok: false; readonly error: string };
  /** Pause the session goal with an exact reason. */
  pause(reason: string): { readonly ok: true; readonly goal: Goal } | { readonly ok: false; readonly error: string };
  /** Resume the paused session goal. */
  resume(): { readonly ok: true; readonly goal: Goal } | { readonly ok: false; readonly error: string };
  /** Return the current session goal, or undefined when none exists. */
  get(): Goal | undefined;
  /** Remove the session goal so a later creation is allowed. */
  clear(): boolean;
  /** Fold the log fresh and return the current session goal state. */
  fold(): Map<string, Goal>;
}

/** Fold a goal JSONL log into the current per-session goal state. */
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

export function createGoalStore(filePath: string, rootSessionId: string): GoalStore {
  let index = foldGoalLog(filePath);

  const append = (event: GoalEvent): void => {
    processWithLog({ operation: PERSISTENCE_OPERATIONS.GOAL_APPEND, parameters: { event: event.event, rootSessionId: event.rootSessionId } }, () => {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, `${serializeGoalEvent(event)}\n`, { flag: "a" });
      index = foldGoalLog(filePath);
    });
  };

  return {
    filePath,
    rootSessionId,
    append,
    create({ cwd, prompt, intervalMs }) {
      if (index.has(rootSessionId)) {
        return { ok: false, error: "a goal already exists for this session; clear it first" };
      }
      const goalId = randomUUID();
      const timestamp = Date.now();
      append({ event: "goal_created", cwd, rootSessionId, goalId, timestamp, prompt, intervalMs });
      return { ok: true, goal: index.get(rootSessionId)! };
    },
    pause(reason) {
      const current = index.get(rootSessionId);
      if (!current) return { ok: false, error: "no goal exists for this session" };
      append({ event: "goal_paused", cwd: current.cwd, rootSessionId, goalId: current.goalId, timestamp: Date.now(), reason });
      return { ok: true, goal: index.get(rootSessionId)! };
    },
    resume() {
      const current = index.get(rootSessionId);
      if (!current) return { ok: false, error: "no goal exists for this session" };
      append({ event: "goal_resumed", cwd: current.cwd, rootSessionId, goalId: current.goalId, timestamp: Date.now() });
      return { ok: true, goal: index.get(rootSessionId)! };
    },
    get() {
      return index.get(rootSessionId);
    },
    clear() {
      const current = index.get(rootSessionId);
      if (!current) return false;
      append({ event: "goal_cleared", cwd: current.cwd, rootSessionId, goalId: current.goalId, timestamp: Date.now() });
      return true;
    },
    fold() {
      index = foldGoalLog(filePath);
      return index;
    },
  };
}

export { goalsFile };
