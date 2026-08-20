import assert from "node:assert/strict";
import { test } from "node:test";
import { createChildLiveFeed, type ChildLiveEvent } from "@xzy-ai/core";

test("child live feed reduces message and tool events into a retained snapshot", () => {
  const feed = createChildLiveFeed();
  const seen: ChildLiveEvent["type"][] = [];
  feed.subscribe((event) => seen.push(event.type));

  feed.emit({ type: "message", id: "m1", phase: "start", role: "assistant", text: "hel" });
  feed.emit({ type: "message", id: "m1", phase: "update", role: "assistant", text: "hello" });
  feed.emit({ type: "tool", id: "t1", phase: "start", toolCallId: "call-1", toolName: "bash", text: "" });
  feed.emit({
    type: "tool",
    id: "t1",
    phase: "end",
    toolCallId: "call-1",
    toolName: "bash",
    text: "ok",
    isError: false,
  });

  assert.deepEqual(seen, ["message", "message", "tool", "tool"]);
  assert.deepEqual(feed.snapshot.transcript, [
    { id: "m1", kind: "message", role: "assistant", text: "hello", complete: false },
    {
      id: "t1",
      kind: "tool",
      toolCallId: "call-1",
      toolName: "bash",
      args: undefined,
      text: "ok",
      complete: true,
      isError: false,
    },
  ]);
  assert.equal(feed.snapshot.status, "running");
  assert.equal(feed.snapshot.settled, false);
});

test("child live feed accumulates tool uses and token usage from finalized assistant messages", () => {
  const feed = createChildLiveFeed();

  feed.emit({ type: "message", id: "m1", phase: "end", role: "assistant", text: "first", usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, cost: 0.01 } });
  assert.deepEqual(feed.snapshot.counters, { toolUses: 0, inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0, cost: 0.01 });

  feed.emit({ type: "tool", id: "t1", phase: "start", toolCallId: "call-1", toolName: "grep", text: "" });
  feed.emit({ type: "tool", id: "t2", phase: "start", toolCallId: "call-2", toolName: "read", text: "" });
  feed.emit({ type: "tool", id: "t2", phase: "end", toolCallId: "call-2", toolName: "read", text: "ok", isError: false });
  assert.equal(feed.snapshot.counters.toolUses, 2, "tool uses count distinct tool call ids");

  feed.emit({ type: "message", id: "m2", phase: "end", role: "assistant", text: "second", usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 3, cost: 0.005 } });
  assert.deepEqual(feed.snapshot.counters, { toolUses: 2, inputTokens: 140, outputTokens: 30, cacheReadTokens: 5, cacheWriteTokens: 3, cost: 0.015 });
  assert.ok(feed.snapshot.startedAtMs !== undefined, "startedAtMs is captured from the first event");
});

test("child live feed settlement preserves accumulated counters and the start time", () => {
  const feed = createChildLiveFeed();
  feed.emit({ type: "message", id: "m1", phase: "end", role: "assistant", text: "first", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0 } });
  feed.emit({ type: "tool", id: "t1", phase: "start", toolCallId: "call-1", toolName: "bash", text: "" });
  feed.emit({ type: "settled", status: "completed" });

  assert.deepEqual(feed.snapshot.counters, { toolUses: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 });
  assert.equal(feed.snapshot.settled, true);
  assert.ok(feed.snapshot.startedAtMs !== undefined, "settlement keeps the captured start time");
});

test("child live feed retains settlement and replays it to late subscribers", () => {
  const feed = createChildLiveFeed();
  const first: ChildLiveEvent["type"][] = [];
  const unsubscribe = feed.subscribe((event) => first.push(event.type));

  feed.emit({ type: "agent_end", willRetry: false });
  feed.emit({ type: "settled", status: "failed" });
  feed.emit({ type: "settled", status: "completed" });
  unsubscribe();

  assert.deepEqual(first, ["agent_end", "settled"]);
  assert.equal(feed.snapshot.status, "failed");
  assert.equal(feed.snapshot.settled, true);

  const late: ChildLiveEvent["type"][] = [];
  feed.subscribe((event) => late.push(event.type));
  assert.deepEqual(late, ["settled"]);
});

test("child live feed unsubscribes without aborting or changing retained state", () => {
  const feed = createChildLiveFeed();
  let calls = 0;
  const unsubscribe = feed.subscribe(() => calls++);
  unsubscribe();
  feed.emit({ type: "message", id: "m1", phase: "end", role: "user", text: "steer me" });

  assert.equal(calls, 0);
  assert.equal(feed.snapshot.transcript[0]?.text, "steer me");
  assert.equal(feed.snapshot.settled, false);
});
