import assert from "node:assert/strict";
import { test } from "node:test";
import { createChildLiveFeed } from "@xzy-ai/core";
import { mapAgentSessionEvent } from "@xzy-ai/runtime";

test("maps SDK message and tool events to the core live feed", () => {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    timestamp: 1,
  };
  const assistantEvent = {
    type: "text_delta",
    contentIndex: 0,
    delta: "hello",
    partial: message,
  };
  assert.deepEqual(
    mapAgentSessionEvent({ type: "message_start", message }),
    { type: "message", id: "assistant-1", phase: "start", role: "assistant", text: "hello" },
  );
  assert.deepEqual(
    mapAgentSessionEvent({ type: "message_update", message, assistantMessageEvent: assistantEvent }),
    { type: "message", id: "assistant-1", phase: "update", role: "assistant", text: "hello" },
  );
  assert.deepEqual(
    mapAgentSessionEvent({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: {} }),
    { type: "tool", id: "call-1", phase: "start", toolCallId: "call-1", toolName: "bash", text: "" },
  );
  assert.deepEqual(
    mapAgentSessionEvent({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "ok" }] },
      isError: false,
    }),
    {
      type: "tool",
      id: "call-1",
      phase: "end",
      toolCallId: "call-1",
      toolName: "bash",
      text: "ok",
      isError: false,
    },
  );
});

test("maps agent end and settlement boundaries without treating streaming as settlement", () => {
  assert.deepEqual(mapAgentSessionEvent({ type: "agent_end", messages: [], willRetry: false }), {
    type: "agent_end",
    willRetry: false,
  });
  assert.deepEqual(mapAgentSessionEvent({ type: "agent_settled" }), {
    type: "settled",
    status: "completed",
  });
});

test("live feed can be driven by mapped events and retains terminal status", () => {
  const feed = createChildLiveFeed();
  const event = mapAgentSessionEvent({ type: "agent_settled" });
  feed.emit(event);
  assert.equal(feed.snapshot.settled, true);
  assert.equal(feed.snapshot.status, "completed");
});
