export type GoalStatus = "active" | "paused";

export interface Goal {
  readonly goalId: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly intervalMs: number;
  readonly status: GoalStatus;
  readonly pauseReason?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface GoalCreationInput {
  readonly goalId: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly intervalMs: number;
  readonly timestamp: number;
}

export function createGoalRecord(input: GoalCreationInput): Goal {
  return {
    goalId: input.goalId,
    cwd: input.cwd,
    prompt: input.prompt,
    intervalMs: input.intervalMs,
    status: "active",
    pauseReason: undefined,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  };
}

export function pauseGoalRecord(goal: Goal, reason: string, timestamp: number): Goal {
  return {
    ...goal,
    status: "paused",
    pauseReason: reason,
    updatedAt: timestamp,
  };
}

export function resumeGoalRecord(goal: Goal, timestamp: number): Goal {
  return {
    ...goal,
    status: "active",
    pauseReason: undefined,
    updatedAt: timestamp,
  };
}
