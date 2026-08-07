import type { Job, JobUpdate } from "./job.ts";

/**
 * Append-only job events.
 *
 * Each event is a single immutable record appended to the registry log. The
 * registry is the single writer; events are never modified or reordered. A
 * reader folds the log into the current job state.
 */

/** Created first, then a sequence of update events. */
export type JobEvent =
  | { type: "created"; job: Job; at: string }
  | { type: "updated"; jobId: string; update: JobUpdate; at: string };

/** Serialize a job event to a single JSONL line. */
export function serializeJobEvent(event: JobEvent): string {
  return JSON.stringify(event);
}

/** Parse a single JSONL line back into a job event, or null when malformed. */
export function parseJobEvent(line: string): JobEvent | null {
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as JobEvent;
    if (parsed && typeof parsed.type === "string") return parsed;
  } catch {
    // Malformed line: skip it and keep the rest of the log intact.
  }
  return null;
}
