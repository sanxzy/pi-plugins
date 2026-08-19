export const DEFAULT_GOAL_INTERVAL_MS = 10 * 60 * 1_000;
/** The default cap used when setting up a bound; a positive safe upper ceiling. */
export const DEFAULT_MAX_GOAL_PROMPT_LENGTH = 10_000;
/** Backward-compatible name for the default goal prompt safety cap. */
export const MAX_GOAL_PROMPT_LENGTH = DEFAULT_MAX_GOAL_PROMPT_LENGTH;

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

/**
 * Separate the optional leading interval syntax from a goal request.
 *
 * `/goal 2m check the build` is represented as interval metadata plus the
 * remaining exact prompt. A caller that already supplied `interval` should
 * pass the prompt directly to validation instead of using this helper.
 */
export function splitGoalPromptInterval(prompt: string): {
  readonly prompt: string;
  readonly interval?: string;
} {
  const match = /^(\d+[smhd])[ \t]+(.+)$/.exec(prompt);
  if (!match) return { prompt };
  return { prompt: match[2]!, interval: match[1]! };
}

/** Validate a goal prompt while preserving every accepted character exactly. */
export function validateGoalInput(
  input: {
    readonly prompt: string;
    readonly interval?: string;
  },
  maxPromptLength = DEFAULT_MAX_GOAL_PROMPT_LENGTH,
): GoalValidationResult {
  if (input.prompt.trim().length === 0) {
    return { ok: false, error: "prompt must contain non-whitespace text" };
  }
  if ([...input.prompt].length > maxPromptLength) {
    return { ok: false, error: `prompt must be at most ${maxPromptLength} Unicode characters` };
  }
  const interval = parseGoalInterval(input.interval);
  if (!interval.ok) return interval;
  return { ok: true, value: { prompt: input.prompt, intervalMs: interval.value } };
}
