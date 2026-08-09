import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_GOAL_INTERVAL_MS,
  createGoalRecord,
  foldGoalEvents,
  parseGoalInterval,
  pauseGoalRecord,
  resumeGoalRecord,
  validateGoalInput,
  type GoalEvent,
} from "@xzy-ai/core";

test("goal duration parsing accepts simple positive units and defaults to ten minutes", () => {
  assert.equal(parseGoalInterval(undefined).value, DEFAULT_GOAL_INTERVAL_MS);
  assert.equal(parseGoalInterval("30s").value, 30_000);
  assert.equal(parseGoalInterval("2h").value, 7_200_000);
  assert.equal(parseGoalInterval("1d").value, 86_400_000);
  assert.equal(parseGoalInterval("0m").ok, false);
  assert.equal(parseGoalInterval("ten minutes").ok, false);
});

test("goal validation preserves prompt and rejects empty or overlong input", () => {
  const valid = validateGoalInput({ prompt: "  exact goal  ", interval: "5m" });
  assert.deepEqual(valid, { ok: true, value: { prompt: "  exact goal  ", intervalMs: 300_000 } });
  assert.equal(validateGoalInput({ prompt: "   " }).ok, false);
  assert.equal(validateGoalInput({ prompt: "😀".repeat(4_001) }).ok, false);
});

test("goal records transition immutably and retain exact pause reason", () => {
  const created = createGoalRecord({
    goalId: "goal-1",
    cwd: "/project",
    prompt: "  preserve this  ",
    intervalMs: 60_000,
    timestamp: 100,
  });
  assert.equal(created.status, "active");
  const paused = pauseGoalRecord(created, "waiting for approval", 200);
  assert.equal(paused.status, "paused");
  assert.equal(paused.pauseReason, "waiting for approval");
  assert.equal(created.status, "active");
  const resumed = resumeGoalRecord(paused, 300);
  assert.equal(resumed.status, "active");
  assert.equal(resumed.pauseReason, undefined);
});

test("goal events fold current state for multiple cwd values and clear records", () => {
  const events: GoalEvent[] = [
    { event: "goal_created", cwd: "/a", goalId: "a", timestamp: 1, prompt: "A", intervalMs: 10 },
    { event: "goal_created", cwd: "/b", goalId: "b", timestamp: 2, prompt: "B", intervalMs: 20 },
    { event: "goal_paused", cwd: "/a", goalId: "a", timestamp: 3, reason: "blocked" },
    { event: "goal_resumed", cwd: "/a", goalId: "a", timestamp: 4 },
    { event: "goal_cleared", cwd: "/b", goalId: "b", timestamp: 5 },
  ];
  const folded = foldGoalEvents(events);
  assert.equal(folded.get("/a")?.status, "active");
  assert.equal(folded.get("/a")?.prompt, "A");
  assert.equal(folded.has("/b"), false);
});
