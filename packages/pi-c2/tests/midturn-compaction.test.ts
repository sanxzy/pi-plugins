import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * Mid-turn strict enforcement tests (message_end based).
 *
 * The percentage threshold must be enforced after EVERY complete message
 * (message_end, any role — user, assistant, toolResult), not just at turn
 * boundaries. The moment a completed message pushes context usage to/above the
 * configured percentage, the active agent turn is aborted immediately and
 * compaction runs. The message included in the compaction is always complete
 * (never cut off mid-message). After compaction the interrupted turn
 * auto-continues.
 *
 * These tests drive a real AgentSession with a fake ModelRuntime whose
 * streamSimple() returns a scripted stream. No network, no API keys.
 */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-c2-midturn-"));
}

interface ScriptedStreamOptions {
  contextWindow: number;
  thresholdPercent: number;
  /** Absolute path the scripted `read` tool call targets. */
  readPath: string;
  /** When set, summarization result() calls await this gate (race testing). */
  summaryGate?: () => Promise<void>;
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

function makeAssistantMessage(text: string, totalTokens: number, stopReason: string, toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  > = [];
  if (text) content.push({ type: "text", text });
  for (const call of toolCalls ?? []) content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments });
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
    stopReason: stopReason as "stop" | "toolUse" | "aborted" | "pending",
    timestamp: Date.now(),
  };
}

/**
 * Scripted stream for the mid-turn scenario:
 *
 * call 1 (the only assistant message of the prompt): emits a `read` tool call
 *                  with usage below the threshold. The loop executes `read`;
 *                  the tool-result message_end pushes context usage across the
 *                  threshold and aborts the run.
 * call 2 (continuation after the abort): observes the aborted signal and
 *                  terminates with stopReason "aborted".
 * call 3 (continue after compaction): completes normally with `stop`.
 *
 * Compaction summarization calls use .result() and return a summary message.
 */
function scriptedStream(opts: ScriptedStreamOptions, signal: AbortSignal | undefined, state: { calls: number }) {
  const contextWindow = opts.contextWindow;
  const threshold = opts.thresholdPercent;
  // Assistant usage sits ABOVE the threshold (e.g. 170k of a 200k window at
  // 80% = 160k), so the first assistant message_end (toolUse) crosses it and
  // the mid-turn check aborts the run.
  const below = Math.floor((contextWindow * (threshold + 5)) / 100);
  const summaryMessage = makeAssistantMessage("Summarized conversation.", 50, "stop");

  let finalResult = summaryMessage;
  // Summarization calls (cacheRetention "none") resolve via result() WITHOUT
  // iterating. When a summaryGate is configured, block the first summary so
  // the test can start a second overlapping compaction while the first is
  // still awaiting its summarization result().
  let gateUsed = false;
  const result = async () => {
    if (opts.summaryGate && !gateUsed) {
      gateUsed = true;
      await opts.summaryGate();
    }
    return finalResult;
  };
  const iterator = (async function* () {
    const call = ++state.calls;
    if (call === 1) {
      // Assistant asks to read a file (toolUse), usage below threshold.
      const tc = [{ id: "call-1", name: "read", arguments: { path: opts.readPath } }];
      const doneMessage = makeAssistantMessage("Let me read the file.", below, "toolUse", tc);
      finalResult = doneMessage;
      const partial = makeAssistantMessage("Let me read the file.", below, "pending", tc);
      yield { type: "start", partial };
      yield { type: "toolcall_start", contentIndex: 0, partial };
      yield { type: "toolcall_delta", contentIndex: 0, delta: "call-1", partial };
      yield { type: "toolcall_end", contentIndex: 0, toolCall: tc[0], partial };
      yield { type: "done", reason: "toolUse", message: doneMessage };
      return;
    }
    if (call === 2) {
      // The tool-result message_end crossed the threshold and aborted the
      // run; the continuation stream is killed.
      if (signal?.aborted) {
        const abortedMessage = makeAssistantMessage("Let me read the file.", below, "aborted");
        finalResult = abortedMessage;
        yield { type: "error", reason: "aborted", error: abortedMessage };
        return;
      }
      const noAbortMessage = makeAssistantMessage("No abort happened (RED).", below, "stop");
      finalResult = noAbortMessage;
      yield { type: "done", reason: "stop", message: noAbortMessage };
      return;
    }
    // call 3 (continue after compaction): complete normally.
    const doneMessage = makeAssistantMessage("Continued after compaction.", 10, "stop");
    finalResult = doneMessage;
    const partial = makeAssistantMessage("Continued ", 10, "pending");
    yield { type: "start", partial };
    yield { type: "text_start", contentIndex: 0, partial };
    yield { type: "text_delta", contentIndex: 0, delta: "after compaction.", partial: makeAssistantMessage("Continued after compaction.", 10, "pending") };
    yield { type: "done", reason: "stop", message: doneMessage };
  })();

  return {
    [Symbol.asyncIterator]: () => iterator,
    result,
  };
}

function fakeRuntime(opts: ScriptedStreamOptions): ModelRuntime {
  // Shared across stream instances: the agent loop calls streamSimple once per
  // assistant response, so the script must progress per call, not per stream.
  const state = { calls: 0 };
  return {
    streamSimple: (_model: unknown, _context: unknown, options: { signal?: AbortSignal }) =>
      scriptedStream(opts, options?.signal, state),
    getAuth: async () => ({ auth: { apiKey: "test-key" } }),
    isUsingOAuth: () => false,
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ type: "api_key" }),
    getModel: () => makeModel(opts.contextWindow),
    getAvailableSnapshot: () => [makeModel(opts.contextWindow)],
  } as unknown as ModelRuntime;
}

async function createTestSession(opts: ScriptedStreamOptions) {
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
  // Pre-seed a long prior conversation so prepareCompaction() has history to
  // summarize (a tiny session cannot compact: nothing exceeds keepRecentTokens).
  // ~80 pairs × ~300 tokens ≈ 24k tokens > keepRecentTokens (20k).
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

test("message_end: a completed assistant message crossing the threshold aborts the turn immediately and compacts", async () => {
  const cwd = tempDir();
  const filePath = join(cwd, "target.txt");
  writeFileSync(filePath, "small file");
  const { session } = await createTestSession({ contextWindow: 200_000, thresholdPercent: 80, readPath: filePath });
  try {

    const events: string[] = [];
    const unsubscribe = session.subscribe((event: { type: string }) => {
      if (event.type === "compaction_start" || event.type === "compaction_end" || event.type === "agent_end") {
        events.push(event.type);
      }
    });

    // Apply the threshold override (same mechanism as registerContextAutoCompact).
    session.settingsManager.setCompactionThresholdPercent(80);

    // Turn 1 completes below threshold; turn 2's tool-result message_end
    // crosses it and MUST abort the run + compact.
    await session.prompt("Do the thing");

    // The turn was interrupted mid-turn: compaction ran.
    assert.ok(events.includes("compaction_start"), "compaction must start after the mid-turn abort");
    assert.ok(events.includes("compaction_end"), "compaction must complete");
    unsubscribe();
  } finally {
    session.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("message_end: the aborted turn auto-continues after compaction without a manual message", async () => {
  const cwd = tempDir();
  const filePath = join(cwd, "target.txt");
  writeFileSync(filePath, "small file");
  const { session } = await createTestSession({ contextWindow: 200_000, thresholdPercent: 80, readPath: filePath });
  try {

    let compactions = 0;
    const events: string[] = [];
    const unsubscribe = session.subscribe((event: { type: string }) => {
      if (event.type === "compaction_end") compactions++;
      if (event.type === "agent_end") events.push(`agent_end:${compactions}`);
    });

    session.settingsManager.setCompactionThresholdPercent(80);

    await session.prompt("Do the thing");

    // Exactly one compaction (the mid-turn abort), and the turn auto-continued
    // (agent_end fired again after compaction — the fake stream completed the
    // resumed turn normally). No synthetic user message was sent.
    assert.equal(compactions, 1, "exactly one compaction must run");
    assert.ok(
      events.length >= 2,
      `expected at least 2 agent_end events (abort + auto-continue), got ${events.join(", ")}`,
    );
    unsubscribe();
  } finally {
    session.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("overlapping manual compactions never read a cleared shared controller (signal race)", async () => {
  const cwd = tempDir();
  const filePath = join(cwd, "target.txt");
  writeFileSync(filePath, "small file");
  // Gate the FIRST summarization result() so the test can start a second
  // compaction while the first is still awaiting its summary. The SDK shares
  // one _compactionAbortController field across concurrent compact() calls;
  // when the second finishes first its finally clears the field and the first
  // must not read undefined.signal.
  let releaseSummary: (() => void) | undefined;
  const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve; });
  const { session } = await createTestSession({
    contextWindow: 200_000,
    thresholdPercent: 80,
    readPath: filePath,
    summaryGate: () => summaryGate,
  });
  try {
    let compactions = 0;
    let failures = 0;
    const unsubscribe = session.subscribe((event: { type: string; errorMessage?: string }) => {
      if (event.type === "compaction_end") {
        compactions++;
        if (event.errorMessage) failures++;
      }
    });

    session.settingsManager.setCompactionThresholdPercent(80);

    // Compaction #1 starts and its summarization is gated.
    const first = session.compact();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Compaction #2 starts while #1 is still awaiting: it shares the
    // controller field, finishes first, and clears it.
    const second = session.compact();
    // Release #1's summary. It must not read undefined.signal.
    releaseSummary!();
    await Promise.allSettled([first, second]);

    assert.ok(compactions >= 1, "at least one compaction_end must be emitted");
    assert.equal(failures, 0, `no compaction_end errorMessage: ${failures}`);
    unsubscribe();
  } finally {
    session.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});
