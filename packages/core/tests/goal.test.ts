import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_GOAL_INTERVAL_MS,
  createGoalRecord,
  foldGoalEvents,
  parseGoalEvent,
  parseGoalInterval,
  pauseGoalRecord,
  splitGoalPromptInterval,
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

test("goal request parsing separates a leading interval from the exact prompt", () => {
  assert.deepEqual(splitGoalPromptInterval("2m testing goal"), {
    interval: "2m",
    prompt: "testing goal",
  });
  assert.deepEqual(splitGoalPromptInterval("testing goal"), { prompt: "testing goal" });
});

test("goal validation preserves prompt and rejects empty or overlong input", () => {
  const valid = validateGoalInput({ prompt: "  exact goal  ", interval: "5m" });
  assert.deepEqual(valid, { ok: true, value: { prompt: "  exact goal  ", intervalMs: 300_000 } });
  assert.equal(validateGoalInput({ prompt: "   " }).ok, false);
  assert.equal(validateGoalInput({ prompt: "😀".repeat(10_001) }).ok, false);
});

test("goal validation accepts a centralized prompt-length bound", () => {
  assert.equal(validateGoalInput({ prompt: "12345" }, 4).ok, false);
  assert.equal(validateGoalInput({ prompt: "12345" }, 5).ok, true);
  assert.equal(validateGoalInput({ prompt: "😀😀😀" }, 2).ok, false);
});

test("goal records transition immutably and retain exact pause reason", () => {
  const created = createGoalRecord({
    goalId: "goal-1",
    rootSessionId: "root-1",
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

test("goal events fold current state for multiple root sessions and clear records", () => {
  const events: GoalEvent[] = [
    { event: "goal_created", cwd: "/a", rootSessionId: "a", goalId: "a", timestamp: 1, prompt: "A", intervalMs: 10 },
    { event: "goal_created", cwd: "/b", rootSessionId: "b", goalId: "b", timestamp: 2, prompt: "B", intervalMs: 20 },
    { event: "goal_paused", cwd: "/a", rootSessionId: "a", goalId: "a", timestamp: 3, reason: "blocked" },
    { event: "goal_resumed", cwd: "/a", rootSessionId: "a", goalId: "a", timestamp: 4 },
    { event: "goal_cleared", cwd: "/b", rootSessionId: "b", goalId: "b", timestamp: 5 },
  ];
  const folded = foldGoalEvents(events);
  assert.equal(folded.get("a")?.status, "active");
  assert.equal(folded.get("a")?.prompt, "A");
  assert.equal(folded.has("b"), false);
});

test("goal event parsing skips malformed payloads and mismatched lifecycle ids", () => {
  assert.equal(parseGoalEvent("{not json}"), null);
  assert.equal(parseGoalEvent('{"event":"goal_created"}'), null);
  assert.equal(parseGoalEvent(JSON.stringify({
    event: "goal_created",
    cwd: "/a",
    rootSessionId: "a",
    goalId: "a",
    timestamp: 1,
    prompt: "A",
    intervalMs: 10,
  }))?.event, "goal_created");

  const folded = foldGoalEvents([
    { event: "goal_created", cwd: "/a", rootSessionId: "a", goalId: "a", timestamp: 1, prompt: "A", intervalMs: 10 },
    { event: "goal_paused", cwd: "/a", rootSessionId: "a", goalId: "other", timestamp: 2, reason: "wrong goal" },
    { event: "goal_cleared", cwd: "/a", rootSessionId: "a", goalId: "other", timestamp: 3 },
  ]);
  assert.equal(folded.get("a")?.status, "active");
});

test("pause and resume preserve exact timestamps and retain fields", () => {
  const created = createGoalRecord({
    goalId: "goal-1",
    rootSessionId: "root-1",
    cwd: "/project",
    prompt: "  exact  ",
    intervalMs: 60_000,
    timestamp: 100,
  });
  const paused = pauseGoalRecord(created, "waiting", 200);
  assert.equal(paused.createdAt, 100);
  assert.equal(paused.updatedAt, 200);
  assert.equal(paused.pauseReason, "waiting");
  const resumed = resumeGoalRecord(paused, 300);
  assert.equal(resumed.createdAt, 100);
  assert.equal(resumed.updatedAt, 300);
  assert.equal(resumed.pauseReason, undefined);
  assert.equal(resumed.prompt, "  exact  ");
});

test("goal_interval_updated folds into the existing record without replacing it", () => {
  const events = [
    { event: "goal_created", cwd: "/project", rootSessionId: "root", goalId: "g1", timestamp: 1_000, prompt: "ship it", intervalMs: 600_000 },
    { event: "goal_paused", cwd: "/project", rootSessionId: "root", goalId: "g1", timestamp: 2_000, reason: "waiting" },
    { event: "goal_interval_updated", cwd: "/project", rootSessionId: "root", goalId: "g1", timestamp: 3_000, intervalMs: 120_000 },
  ] as const;
  const goal = foldGoalEvents(events).get("root");
  assert.equal(goal?.intervalMs, 120_000);
  assert.equal(goal?.prompt, "ship it");
  assert.equal(goal?.status, "paused");
  assert.equal(goal?.pauseReason, "waiting");
});
