import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { createChildLiveFeed } from "@xzy-ai/core";
import {
  attachAgentSessionLiveFeed,
  liveStatusForSession,
  mapAgentSessionEvent,
  spawnChildSession,
} from "@xzy-ai/runtime";
import { inheritedMcpRenderCall, inheritedMcpRenderResult } from "../src/infrastructure/pi-sdk/render-safe.ts";

type MessageShape = {
  role: "user" | "assistant";
  content: unknown;
  timestamp: number;
  responseId?: string;
};

const NOOP = () => {};
const identityTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

test("inherited MCP renderers redact expanded token and transport traces", () => {
  const args = { access_token: "tok-secret", refreshToken: "refresh-secret", requestId: "req-secret", traceId: "trace-secret", clientId: "client-id", client_id: "client-id-2", authorization: "Bearer abc.def" };
  const call = stripVTControlCharacters(inheritedMcpRenderCall("lookup", "lookup", identityTheme, { expanded: true, args }).render(120).join("\n"));
  assert.doesNotMatch(call, /tok-secret|refresh-secret|req-secret|abc\.def/);
  const result = stripVTControlCharacters(inheritedMcpRenderResult({ content: [{ type: "text", text: "safe access_token=tok-secret requestId=req-secret traceId=trace-secret client_secret=client-secret client_id=client-id api_secret=api-secret https://example.test/?client_secret=url-secret&client_id=url-id" }], details: args }, { expanded: true, isPartial: false }, identityTheme, {}).render(120).join("\n"));
  assert.match(result, /safe/);
  assert.doesNotMatch(result, /\"details\"/);
  assert.doesNotMatch(result, /tok-secret|refresh-secret|req-secret|trace-secret|abc\.def|client-secret|client-id|api-secret|url-secret|url-id/);
});

test("inherited MCP renderers hide payload output while retaining the tool activity label", () => {
  const call = stripVTControlCharacters(inheritedMcpRenderCall("server_lookup", "server_lookup", identityTheme).render(100).join(""));
  const result = stripVTControlCharacters(inheritedMcpRenderResult(
    { content: [{ type: "text", text: "SECRET_MCP_OUTPUT" }], details: { isError: false } },
    { expanded: false, isPartial: false },
    identityTheme,
    { isError: false },
  ).render(100).join(""));
  assert.match(call, /server_lookup/);
  const expandedCall = stripVTControlCharacters(inheritedMcpRenderCall("server_lookup", "server_lookup", identityTheme, { expanded: true, args: { query: "inspect this" } }).render(100).join(""));
  assert.match(expandedCall, /\"query\"/);
  assert.match(expandedCall, /inspect this/);
  assert.doesNotMatch(result, /SECRET_MCP_OUTPUT/);
  const expanded = stripVTControlCharacters(inheritedMcpRenderResult(
    { content: [{ type: "text", text: "SAFE_MCP_OUTPUT" }] },
    { expanded: true, isPartial: false },
    identityTheme,
    { isError: false },
  ).render(100).join(""));
  assert.match(expanded, /SAFE_MCP_OUTPUT/);

  const sensitive = stripVTControlCharacters(inheritedMcpRenderResult(
    { content: [{ type: "text", text: "chatId=123456 bot123:SECRET https://user:pass@example.com/?token=secret" }] },
    { expanded: true, isPartial: false },
    identityTheme,
    { isError: false },
  ).render(200).join(""));
  assert.doesNotMatch(sensitive, /123456|bot123:SECRET|user:pass|token=secret/);
});

test("maps SDK message and tool events to the core live feed", () => {
  const message = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "hello" }],
    timestamp: 1,
  } as never;
  const assistantEvent = {
    type: "text_delta" as const,
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
    mapAgentSessionEvent({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "ls" } }),
    {
      type: "tool",
      id: "call-1",
      phase: "start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "ls" },
      text: "",
    },
  );
  assert.deepEqual(
    mapAgentSessionEvent({
      type: "tool_execution_update",
      toolCallId: "call-2",
      toolName: "read",
      args: { path: "file.ts" },
      partialResult: { content: [{ type: "text", text: "partial" }] },
    }),
    {
      type: "tool",
      id: "call-2",
      phase: "update",
      toolCallId: "call-2",
      toolName: "read",
      args: { path: "file.ts" },
      text: "partial",
    },
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

test("live feed retains tool-call args for runtime control but UI must not render them", () => {
  const feed = createChildLiveFeed();
  feed.emit({
    type: "tool",
    id: "call-1",
    phase: "start",
    toolCallId: "call-1",
    toolName: "bash",
    args: { command: "ls -la", cwd: "/repo" },
    text: "",
  });
  feed.emit({
    type: "tool",
    id: "call-1",
    phase: "end",
    toolCallId: "call-1",
    toolName: "bash",
    text: "done",
    isError: false,
  });
  assert.equal(feed.snapshot.transcript.length, 1);
  const entry = feed.snapshot.transcript[0];
  assert.equal(entry.kind, "tool");
  if (entry.kind === "tool") {
    assert.deepEqual(entry.args, { command: "ls -la", cwd: "/repo" }, "args are retained on the completed entry");
  }
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
  assert.ok(event, "settled maps to a normalized event");
  if (!event) return;
  feed.emit(event);
  assert.equal(feed.snapshot.settled, true);
  assert.equal(feed.snapshot.status, "completed");
});

test("copied SDK message objects share one transcript identity", () => {
  const feed = createChildLiveFeed();
  const lineage = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "thinking" }],
    timestamp: 42,
  };
  // The SDK emits a shallow copy for start/update and the accumulated object
  // for end; none of these share object identity.
  const copies = [0, 1, 2].map(() => ({ ...lineage }));
  const finalMessage = {
    ...lineage,
    content: [{ type: "text" as const, text: "answer" }],
  };
  feed.emit(mapAgentSessionEvent({ type: "message_start", message: copies[0] as never })!);
  feed.emit(mapAgentSessionEvent({ type: "message_update", message: copies[1] as never, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "", partial: copies[1] } as never })!);
  feed.emit(mapAgentSessionEvent({ type: "message_end", message: finalMessage as never })!);
  assert.deepEqual(
    feed.snapshot.transcript,
    [{ id: "assistant-42", kind: "message", role: "assistant", text: "answer", complete: true }],
    "start/update/end copies collapse into one completed entry",
  );
});

test("attachment forwards events, delivers settlement, and unsubscribes without aborting", async () => {
  type SessionEvent = { type: string; [key: string]: unknown };
  const listeners = new Set<(event: SessionEvent) => void>();
  const session = {
    subscribe: (listener: (event: SessionEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    agent: {
      state: {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            timestamp: 9,
            stopReason: "stop",
          },
        ],
      },
    },
    steer: async () => {},
    abort: async () => {},
  };
  const { feed, unsubscribe } = attachAgentSessionLiveFeed(
    session as unknown as Parameters<typeof attachAgentSessionLiveFeed>[0],
  );

  for (const listener of [...listeners]) {
    listener({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 9 } });
  }
  assert.equal(feed.snapshot.transcript.length, 1, "events forwarded into the feed");

  for (const listener of [...listeners]) {
    listener({ type: "agent_settled" });
  }
  assert.equal(feed.snapshot.settled, true, "settlement derives terminal status from final session state");
  assert.equal(feed.snapshot.status, "completed");

  unsubscribe();
  assert.equal(listeners.size, 0, "unsubscribe removes the SDK listener without aborting");
});

test("live status derivation reflects the final assistant stop reason", () => {
  const sessionWith = (stopReason: string | undefined, errorMessage?: string) =>
    ({
      agent: {
        state: {
          messages: [
            stopReason
              ? { role: "assistant", timestamp: 1, stopReason }
              : { role: "assistant", timestamp: 1, errorMessage },
          ],
        },
      },
    }) as unknown as Parameters<typeof liveStatusForSession>[0];

  assert.equal(liveStatusForSession(sessionWith("stop")), "completed");
  assert.equal(liveStatusForSession(sessionWith("toolUse")), "completed");
  assert.equal(liveStatusForSession(sessionWith("aborted")), "cancelled");
  assert.equal(liveStatusForSession(sessionWith("error")), "failed");
  assert.equal(liveStatusForSession(sessionWith(undefined, "boom")), "failed");
  assert.equal(
    liveStatusForSession({ agent: { state: { messages: [] } } } as never),
    "failed",
    "an empty session settles as failed",
  );
});

test("spawn adapter publishes a controllable live handle, retains settlement, and cleans SDK listeners", async () => {
  type Listener = (event: unknown) => void;
  const listeners = new Set<Listener>();
  const steerCalls: string[] = [];
  let abortCalls = 0;
  let disposeCalls = 0;
  let promptRelease: (() => void) | undefined;
  let promptStarted: (() => void) | undefined;
  const promptReady = new Promise<void>((resolve) => {
    promptStarted = resolve;
  });
  const promptDone = new Promise<void>((resolve) => {
    promptRelease = resolve;
  });
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    timestamp: 100,
    stopReason: "stop",
  };
  const session = {
    sessionFile: "/tmp/child-live.jsonl",
    isStreaming: false,
    agent: { state: { messages: [] as unknown[] } },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      promptStarted?.();
      await promptDone;
      session.agent.state.messages.push(message);
      for (const listener of [...listeners]) {
        listener({ type: "message_start", message: { ...message } });
        listener({ type: "message_end", message: { ...message } });
        listener({ type: "agent_settled" });
      }
    },
    async steer(prompt: string) {
      steerCalls.push(prompt);
    },
    async abort() {
      abortCalls++;
    },
    getLastAssistantText() {
      return "done";
    },
    dispose() {
      disposeCalls++;
    },
  };

  // The concrete control type is intentionally obtained through onControl so
  // this test exercises the public domain seam rather than a private adapter.
  let control: import("@xzy-ai/core").ChildSessionControl | undefined;
  const liveChildren = new Map<string, import("@xzy-ai/core").ChildSessionControl>();
  const previousFactory = spawnChildSession.__createChild;
  spawnChildSession.__createChild = async () => ({
    session: session as never,
    dispose: () => session.dispose(),
  });

  try {
    const runPromise = spawnChildSession({
      jobId: "job-live",
      cwd: "/tmp",
      model: {},
      agent: {} as never,
      prompt: "implement",
      parentSessionId: "parent-live",
      onControl: (next) => {
        control = next;
        liveChildren.set("job-live", next);
      },
      run: async (operation) => operation(),
    });

    await promptReady;
    assert.ok(control?.live, "child publishes a live control before prompt runs");
    assert.equal(liveChildren.has("job-live"), true, "parent pool can publish the child handle");
    await control!.steer("focus on tests");
    assert.deepEqual(steerCalls, ["focus on tests"], "steering reaches the child session");

    promptRelease?.();
    const result = await runPromise;
    assert.equal(result?.status, "completed");
    assert.equal(control!.live!.snapshot.settled, true, "settlement is delivered through the adapter");
    assert.equal(control!.live!.snapshot.status, "completed");
    assert.equal(control!.live!.snapshot.transcript.length, 1, "final transcript is retained after prompt cleanup");
    assert.equal(listeners.size, 0, "adapter cleanup unsubscribes from the SDK session");
    assert.equal(disposeCalls, 1, "child session is disposed after settlement");
    liveChildren.delete("job-live");
    assert.equal(control!.live!.snapshot.settled, true, "retained control remains usable after pool removal");
      assert.equal(abortCalls, 0, "settlement cleanup does not abort the child");
  } finally {
    spawnChildSession.__createChild = previousFactory;
  }
});

test("duplicate timestamps across distinct messages get distinct transcript ids", () => {
  const feed = createChildLiveFeed();
  const first = { role: "assistant", content: "one", timestamp: 7, responseId: "response-1" };
  const second = { role: "assistant", content: "two", timestamp: 7, responseId: "response-2" };
  feed.emit(mapAgentSessionEvent({ type: "message_start", message: first as never })!);
  feed.emit(mapAgentSessionEvent({ type: "message_end", message: first as never })!);
  feed.emit(mapAgentSessionEvent({ type: "message_start", message: second as never })!);
  feed.emit(mapAgentSessionEvent({ type: "message_end", message: second as never })!);
  assert.deepEqual(
    feed.snapshot.transcript.map((entry) => entry.text),
    ["one", "two"],
    "distinct messages sharing a timestamp remain distinct",
  );
});
