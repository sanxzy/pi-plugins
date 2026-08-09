export const DEFAULT_GOAL_INTERVAL_MS = 10 * 60 * 1_000;
export const MAX_GOAL_PROMPT_LENGTH = 4_000;

export type GoalValidationError = { readonly ok: false; readonly error: string };
export type GoalValidationResult =
  | { readonly ok: true; readonly value: { readonly prompt: string; readonly intervalMs: number } }
  | GoalValidationError;

/** Parse a simple positive duration such as 30s, 10m, 2h, or 1d. */
export function parseGoalInterval(value: string | undefined):
  | { readonly ok: true; readonly value: number }
  | GoalValidationError {
  if (value === undefined) return { ok: true, value: DEFAULT_GOAL_INTERVAL_MS };
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) return { ok: false, error: "interval must be a positive duration such as 30s, 10m, 2h, or 1d" };
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return { ok: false, error: "interval must be greater than zero" };
  }
  const multiplier = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s" | "m" | "h" | "d"];
  const intervalMs = amount * multiplier;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    return { ok: false, error: "interval is too large" };
  }
  return { ok: true, value: intervalMs };
}

/** Validate a goal prompt while preserving every accepted character exactly. */
export function validateGoalInput(input: {
  readonly prompt: string;
  readonly interval?: string;
}): GoalValidationResult {
  if (input.prompt.trim().length === 0) {
    return { ok: false, error: "prompt must contain non-whitespace text" };
  }
  if ([...input.prompt].length > MAX_GOAL_PROMPT_LENGTH) {
    return { ok: false, error: `prompt must be at most ${MAX_GOAL_PROMPT_LENGTH} Unicode characters` };
  }
  const interval = parseGoalInterval(input.interval);
  if (!interval.ok) return interval;
  return { ok: true, value: { prompt: input.prompt, intervalMs: interval.value } };
}
