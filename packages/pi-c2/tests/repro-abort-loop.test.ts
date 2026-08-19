import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * Regression for the always-abort-after-compaction loop.
 *
 * After a percentage-threshold compaction (threshold abort + auto-continue),
 * the session's kept window still contains the pre-compaction assistant
 * whose usage reflects the old large context (e.g. 170k of a 200k window).
 * If that stale usage is used for the next message_end's threshold check,
 * the next user prompt aborts immediately, but prepareCompaction returns
 * undefined (last entry is already a compaction) so the abort never compacts
 * and every subsequent operation stays aborted.
 *
 * The next prompt must NOT abort when the last valid usage is from before
 * the latest compaction. This test forces that edge by making the post-
 * compaction continuation's usage invalid (0), so the estimator falls back
 * to the old large usage which is stale and must be ignored.
 */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-c2-repro-"));
}

function makeModel(contextWindow: number) {
  return {
    id: "test-model",
    name: "Test Model",
    api: "anthropic-messages",
    provider: "test-provider",
    baseUrl: "https://test.invalid",
    reasoning: false,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    contextWindow,
    maxTokens: 4096,
  };
}

function makeAssistantMessage(
  text: string,
  totalTokens: number,
  stopReason: string,
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
) {
  const content: Array<any> = [];
  if (text) content.push({ type: "text", text });
  for (const c of toolCalls ?? []) content.push({ type: "toolCall", id: c.id, name: c.name, arguments: c.arguments });
  return {
    role: "assistant" as const,
    content,
    api: "anthropic-messages",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: totalTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: stopReason as any,
    timestamp: Date.now(),
  };
}

function scriptedStream(opts: any, signal: AbortSignal | undefined, state: { calls: number }) {
  const below = Math.floor((opts.contextWindow * (opts.thresholdPercent + 5)) / 100);
  let finalResult: any = makeAssistantMessage("Summarized.", 50, "stop");
  const result = async () => finalResult;
  const iterator = (async function* () {
    const call = ++state.calls;
    if (call === 1) {
      const tc = [{ id: "call-1", name: "read", arguments: { path: opts.readPath } }];
      const done = makeAssistantMessage("Let me read.", below, "toolUse", tc);
      finalResult = done;
      const partial = makeAssistantMessage("Let me read.", below, "pending", tc);
      yield { type: "start", partial };
      yield { type: "toolcall_start", contentIndex: 0, partial };
      yield { type: "toolcall_delta", contentIndex: 0, delta: "call-1", partial };
      yield { type: "toolcall_end", contentIndex: 0, toolCall: tc[0], partial };
      yield { type: "done", reason: "toolUse", message: done };
      return;
    }
    if (call === 2) {
      if (signal?.aborted) {
        const aborted = makeAssistantMessage("aborted.", below, "aborted");
        finalResult = aborted;
        yield { type: "error", reason: "aborted", error: aborted };
        return;
      }
      const noAbort = makeAssistantMessage("No abort.", below, "stop");
      finalResult = noAbort;
      yield { type: "done", reason: "stop", message: noAbort };
      return;
    }
    if (call === 3) {
      const done = makeAssistantMessage("Continued after compaction.", 0, "stop");
      finalResult = done;
      const partial = makeAssistantMessage("Continued ", 10, "pending");
      yield { type: "start", partial };
      yield { type: "text_start", contentIndex: 0, partial };
      yield { type: "text_delta", contentIndex: 0, delta: "after compaction.", partial: makeAssistantMessage("Continued after compaction.", 10, "pending") };
      yield { type: "done", reason: "stop", message: done };
      return;
    }
    if (call >= 4) {
      if (signal?.aborted) {
        const aborted = makeAssistantMessage("second aborted", 10, "aborted");
        finalResult = aborted;
        yield { type: "error", reason: "aborted", error: aborted };
        return;
      }
      const done = makeAssistantMessage(`Second prompt response ${call}`, 10, "stop");
      finalResult = done;
      const partial = makeAssistantMessage("Second ", 10, "pending");
      yield { type: "start", partial };
      yield { type: "text_delta", contentIndex: 0, delta: `response ${call}`, partial: done };
      yield { type: "done", reason: "stop", message: done };
      return;
    }
  })();
  return { [Symbol.asyncIterator]: () => iterator, result };
}

function fakeRuntime(opts: any): ModelRuntime {
  const state = { calls: 0 };
  return {
    streamSimple: (_m: any, _c: any, options: { signal?: AbortSignal }) => scriptedStream(opts, options?.signal, state),
    getAuth: async () => ({ auth: { apiKey: "test-key" } }),
    isUsingOAuth: () => false,
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ type: "api_key" }),
    getModel: () => makeModel(opts.contextWindow),
    getAvailableSnapshot: () => [makeModel(opts.contextWindow)],
  } as unknown as ModelRuntime;
}

async function createTestSession(opts: any) {
  const cwd = tempDir();
  const agentDir = join(cwd, "agent");
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  const sessionManager = SessionManager.inMemory(cwd);
  for (let i = 0; i < 80; i++) {
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: `Prior user message ${i} ` + "x".repeat(800) }],
      timestamp: Date.now() - (100 - i) * 1000,
    });
    sessionManager.appendMessage(makeAssistantMessage(`Prior assistant response ${i} ` + "y".repeat(800), 600, "stop"));
  }
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: makeModel(opts.contextWindow),
    modelRuntime: fakeRuntime(opts),
    resourceLoader: loader,
    settingsManager,
    sessionManager,
    tools: ["read"],
  });
  return { cwd, session };
}

test("subsequent prompt after threshold compaction must not abort on stale pre-compaction usage", async () => {
  const cwd = tempDir();
  const filePath = join(cwd, "target.txt");
  writeFileSync(filePath, "small file");
  const { session, cwd: cwd2 } = await createTestSession({ contextWindow: 200_000, thresholdPercent: 80, readPath: filePath });
  session.settingsManager.setCompactionThresholdPercent(80);

  await session.prompt("Do the thing");

  // The second prompt follows a compaction whose kept window still contains
  // the large pre-compaction usage. Without the stale-usage guard in
  // _maybeAbortForThreshold, this prompt aborts immediately and every
  // subsequent operation stays aborted.
  await session.prompt("second prompt");

  const aborted = session.state.messages.filter((m: any) => m.stopReason === "aborted");
  assert.equal(aborted.length, 0, `Second prompt should not produce aborted messages, got ${aborted.length}`);

  session.dispose();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(cwd2, { recursive: true, force: true });
});
