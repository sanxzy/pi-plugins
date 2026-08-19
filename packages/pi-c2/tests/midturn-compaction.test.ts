import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * Mid-turn strict enforcement tests.
 *
 * The percentage threshold must be enforced the moment context usage reaches
 * the configured percentage — the active agent turn is aborted immediately and
 * compaction runs, WITHOUT waiting for the turn to finish (streaming output may
 * be interrupted). After compaction the interrupted turn auto-continues.
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

function makeAssistantMessage(text: string, totalTokens: number, stopReason: string) {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
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
    stopReason,
    timestamp: Date.now(),
  };
}

/** Build a duck-typed stream: async-iterable for the turn, .result() for compaction. */
function scriptedStream(opts: ScriptedStreamOptions, signal?: AbortSignal) {
  const usageAtThreshold = Math.floor((opts.contextWindow * opts.thresholdPercent) / 100);
  const longText =
    "Hello, this is a very long streaming response that crosses the configured percentage threshold mid-turn.";
  const finalMessage = makeAssistantMessage(longText, usageAtThreshold, "stop");
  const summaryMessage = makeAssistantMessage("Summarized conversation.", 50, "stop");

  const iterator = (async function* () {
    const partial = makeAssistantMessage("Hel", usageAtThreshold, "pending");
    yield { type: "start", partial };
    yield { type: "text_start", contentIndex: 0, partial };
    yield {
      type: "text_delta",
      contentIndex: 0,
      delta: "lo, this is a very long streaming response that crosses the configured percentage threshold mid-turn.",
      partial: makeAssistantMessage(longText, usageAtThreshold, "pending"),
    };
    if (signal?.aborted) {
      // Mid-turn threshold abort fired: terminate with stopReason "aborted".
      yield { type: "error", reason: "aborted", error: makeAssistantMessage(longText, usageAtThreshold, "aborted") };
      return;
    }
    // Threshold not enforced (RED path): complete normally.
    yield { type: "done", reason: "stop", message: finalMessage };
  })();

  return {
    [Symbol.asyncIterator]: () => iterator,
    result: async () => summaryMessage,
  };
}

function fakeRuntime(opts: ScriptedStreamOptions): ModelRuntime {
  return {
    streamSimple: (_model: unknown, _context: unknown, options: { signal?: AbortSignal }) =>
      scriptedStream(opts, options?.signal),
    getAuth: async () => ({ auth: { apiKey: "test-key" } }),
    isUsingOAuth: () => false,
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ type: "api_key" }),
    getModel: () => makeModel(opts.contextWindow),
    getAvailableSnapshot: () => [makeModel(opts.contextWindow)],
  } as unknown as ModelRuntime;
}

/** Minimal fake resource loader (only getExtensions is used by createAgentSession). */
function fakeResourceLoader(cwd: string, agentDir: string, settingsManager: SettingsManager) {
  return new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
}

async function createTestSession(opts: ScriptedStreamOptions) {
  const cwd = tempDir();
  const agentDir = join(cwd, "agent");
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: makeModel(opts.contextWindow),
    modelRuntime: fakeRuntime(opts),
    resourceLoader: fakeResourceLoader(cwd, agentDir, settingsManager),
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    tools: [],
  });
  return { cwd, session };
}

test("mid-turn: reaching the threshold aborts the active turn immediately and compacts", async () => {
  const { cwd, session } = await createTestSession({ contextWindow: 200_000, thresholdPercent: 80 });
  try {
    const events: string[] = [];
    const unsubscribe = session.subscribe((event: { type: string }) => {
      if (event.type === "compaction_start" || event.type === "compaction_end" || event.type === "agent_end") {
        events.push(event.type);
      }
    });

    // Apply the threshold override (same mechanism as registerContextAutoCompact).
    session.settingsManager.setCompactionThresholdPercent(80);

    // Send a prompt. The fake stream crosses 80% (160k/200k) on the first
    // delta, so the turn MUST be aborted mid-stream.
    await session.prompt("Do the thing");

    // The turn was interrupted: an abort happened and compaction ran.
    assert.ok(events.includes("compaction_start"), "compaction must start after the mid-turn abort");
    assert.ok(events.includes("compaction_end"), "compaction must complete");
    unsubscribe();
  } finally {
    session.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("mid-turn: the aborted turn auto-continues after compaction without a manual message", async () => {
  const { cwd, session } = await createTestSession({ contextWindow: 200_000, thresholdPercent: 80 });
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
