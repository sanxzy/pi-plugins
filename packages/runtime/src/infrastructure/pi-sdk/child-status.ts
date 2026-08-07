/**
 * Child status observation.
 *
 * A child's status is derived from its runtime streaming state plus the final
 * assistant `stopReason`/`errorMessage` — never from a bare streaming flag,
 * because streaming extends through awaited event listeners and session-level
 * continuations. This module is pure and unit-testable without a live session.
 */

/** Observable child statuses. */
export type ChildStatus = "idle" | "streaming" | "completed" | "aborted" | "failed";

/** Minimal resolved view of a child session's terminal state. */
export interface ChildStatusInput {
  /** Whether the session is currently processing an agent run. */
  isStreaming: boolean;
  /** Final assistant message stop reason, if any assistant message exists. */
  stopReason?: string;
  /** Error message from the most recent failed or aborted assistant turn. */
  errorMessage?: string;
}

/**
 * Derive the child status.
 *
 * - `streaming` while a run is active, regardless of any other field.
 * - `aborted` for an `aborted` stop reason, even when an abort error message is recorded.
 * - `failed` for an `error` stop reason or a recorded error message.
 * - `idle` before any assistant message exists (no stop reason yet).
 * - `completed` after a normal stop (`stop`, `length`, `toolUse`).
 */
export function observeChildStatus(input: ChildStatusInput): ChildStatus {
  if (input.isStreaming) return "streaming";
  // Real aborts carry an error message alongside the `aborted` stop reason, so
  // the stop reason must be checked before the error message.
  if (input.stopReason === "aborted") return "aborted";
  if (input.stopReason === "error" || input.errorMessage) return "failed";
  if (!input.stopReason) return "idle";
  return "completed";
}