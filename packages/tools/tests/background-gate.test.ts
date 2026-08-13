import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createJob, MAX_CONCURRENCY } from "@xzy-ai/core";
import { REGISTRY_OPERATIONS, createSessionLogger, runWithLogContext } from "@xzy-ai/observability";
import { encodeProjectId, getChildPool, homeAgentManifestFile, spawnChildSession } from "@xzy-ai/runtime";
import { registerAgentTool } from "../src/registrations/agent.ts";

/**
 * Composition-root regression test for queued background lifecycle.
 *
 * This drives the real agent tool registration with a saturated shared gate and
 * an injected child-session adapter. A waiting background job must remain
 * queued until gate admission; admission then publishes the live handle and
 * changes the registry state to running.
 */

type RegisteredAgent = {
  execute: (
    toolCallId: string,
    params: {
      description: string;
      prompt: string;
      subagent_type: string;
      agent_id?: string;
    },
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ) => Promise<{ content: Array<{ text: string }>; details: { jobId: string; status?: string } }>;
};

function context(cwd: string, mode: string = "tui"): ExtensionContext {
  let sessionId = "root-session";
  let sessionFile: string | undefined = join(cwd, "sessions", "root-session.jsonl");
  return {
    set sessionIdForTest(id: string) { sessionId = id; },
    get sessionManager() {
      return {
        getSessionId: () => sessionId,
        getSessionFile: () => sessionFile,
      };
    },
    mode,
    hasUI: mode === "tui",
    cwd,
    model: {} as ExtensionContext["model"],
    ui: {
      custom: async () => undefined,
      getEditorText: () => "",
      setEditorText: () => {},
    },
  } as unknown as ExtensionContext;
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("agent schema removes the redundant background parameter", () => {
  let registered: { parameters: { properties?: Record<string, unknown> }; description: string } | undefined;
  registerAgentTool({
    registerTool(tool: typeof registered) {
      registered = tool;
    },
  } as unknown as ExtensionAPI);
  assert.ok(registered);
  assert.equal(registered.parameters.properties?.background, undefined);
  assert.match(registered.description, /Prefer agent_id/);
  assert.match(registered.description, /preserves transcript and context/);
  assert.match(registered.description, /foreground/);
});

test("concurrent resumes of the same terminal job launch exactly one child", async () => {
  const previousHome = process.env.PI_CODE_TEST_HOME;
  process.env.PI_CODE_TEST_HOME = mkdtempSync(join(tmpdir(), "pi-code-resume-lease-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-resume-lease-"));
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "agents", "test-agent.md"),
    "---\nname: test-agent\ndescription: Test agent\n---\ntest body",
    "utf8",
  );
  const sessionFile = join(cwd, "sessions", "target-job.jsonl");
  mkdirSync(join(cwd, "sessions"), { recursive: true });
  writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "target-job" })}\n`, "utf8");
  const pool = getChildPool(cwd, "root-session");
  pool.registry.createJob(createJob({
    jobId: "target-job",
    parentSessionId: "root-session",
    sessionId: "target-job",
    status: "completed",
    description: "already done",
    subagentType: "test-agent",
    sessionFile,
  }));

  let childCreated = 0;
  const release = deferred<void>();
  const previousFactory = spawnChildSession.__createChild;
  spawnChildSession.__createChild = async () => {
    childCreated += 1;
    await release.promise;
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "resumed" }],
      timestamp: 1,
      stopReason: "stop",
    };
    const fakeSession = {
      sessionFile,
      isStreaming: false as boolean,
      agent: { state: { messages: [message] as unknown[] } },
      subscribe() {
        return () => {};
      },
      async prompt() {},
      async steer() {},
      async abort() {},
      getLastAssistantText() {
        return "resumed";
      },
      dispose() {},
    };
    return { session: fakeSession as never, dispose: () => fakeSession.dispose() };
  };

  let registered: RegisteredAgent | undefined;
  registerAgentTool({
    registerTool(tool: RegisteredAgent) {
      registered = tool;
    },
  } as unknown as ExtensionAPI);
  try {
    assert.ok(registered);
    const call = () => registered!.execute(
      "call",
      { description: "resume", prompt: "continue", subagent_type: "test-agent", agent_id: "target-job" },
      undefined,
      undefined,
      context(cwd),
    );
    const [first, second] = await Promise.all([call(), call()]);
    assert.ok(first.details.jobId, "first resume is acknowledged");
    assert.ok(second.details.jobId, "second resume is acknowledged");
    await flush();
    await flush();
    assert.equal(childCreated, 1, "two concurrent resumes launch exactly one child");
    release.resolve();
    await flush();
    assert.equal(pool.registry.get("target-job")?.status, "completed");
    const launchingJobs = (pool as unknown as { launchingJobs?: Map<string, unknown> }).launchingJobs;
    assert.equal(launchingJobs?.has("target-job"), false, "the launch lease is released on settle");
  } finally {
    release.resolve();
    spawnChildSession.__createChild = previousFactory;
    rmSync(cwd, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.PI_CODE_TEST_HOME;
    else process.env.PI_CODE_TEST_HOME = previousHome;
  }
});

test("root background spawns remain TUI-only", async () => {
  let registered: RegisteredAgent | undefined;
  registerAgentTool({
    registerTool(tool: RegisteredAgent) {
      registered = tool;
    },
  } as unknown as ExtensionAPI);
  assert.ok(registered);
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-background-mode-"));
  try {
    const result = await registered.execute(
      "call",
      { description: "print", prompt: "work", subagent_type: "test-agent" },
      undefined,
      undefined,
      context(cwd, "print"),
    );
    assert.equal(result.content[0]?.text, "Error: background agents are available only in TUI mode");
    assert.deepEqual(result.details, { jobId: undefined, reason: "background mode is invalid in print mode" });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a running child agent awaits a descendant in print mode", async () => {
  let detailed: RegisteredAgent | undefined;
  registerAgentTool({
    registerTool(tool: RegisteredAgent) {
      detailed = tool;
    },
  } as unknown as ExtensionAPI);
  assert.ok(detailed);
  const previousHome = process.env.PI_CODE_TEST_HOME;
  process.env.PI_CODE_TEST_HOME = mkdtempSync(join(tmpdir(), "pi-code-child-recurse-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-child-recurse-"));
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "agents", "test-agent.md"),
    "---\nname: test-agent\ndescription: Test agent\n---\ntest body",
    "utf8",
  );
  // The descendant child must not actually create a real SDK session; the
  // foreground admission and terminal job recording are what this test asserts.
  const previousFactory = spawnChildSession.__createChild;
  spawnChildSession.__createChild = async () => {
    throw new Error("not spawning a real session in this regression test");
  };
  try {
    const pool = getChildPool(cwd, "root-session");
    pool.registry.createJob(createJob({
      jobId: "child-session",
      parentSessionId: "root-session",
      sessionId: "child-session",
      status: "running",
      description: "child",
      subagentType: "test-agent",
    }));
    const childCtx = context(cwd, "print") as ExtensionContext & { sessionIdForTest: string };
    childCtx.sessionIdForTest = "child-session";
    // The child is a registered running job; its descendant runs foreground
    // even though the SDK runs child sessions in non-interactive `print` mode.
    const result = await detailed!.execute(
      "call",
      { description: "recurse", prompt: "spawn grandchild", subagent_type: "test-agent" },
      undefined,
      undefined,
      childCtx,
    );
    assert.ok(result.details.jobId, "descendant gets a job id");
    assert.match(result.content[0]?.text ?? "", /^Agent test-agent \(.+\) failed\./, "foreground result returned inline");
    const childJob = pool.registry.get(result.details.jobId!);
    assert.equal(childJob?.parentSessionId, "child-session");
    assert.equal(childJob?.status, "failed");
  } finally {
    spawnChildSession.__createChild = previousFactory;
    rmSync(cwd, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.PI_CODE_TEST_HOME;
    else process.env.PI_CODE_TEST_HOME = previousHome;
  }
});

test("a root background agent stays queued until running with a live handle", async () => {
  const previousHome = process.env.PI_CODE_TEST_HOME;
  process.env.PI_CODE_TEST_HOME = mkdtempSync(join(tmpdir(), "pi-code-background-gate-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-background-gate-"));
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "agents", "test-agent.md"),
    "---\nname: test-agent\ndescription: Test agent\n---\ntest body",
    "utf8",
  );
  const pool = getChildPool(cwd, "root-session");
  const held = Array.from({ length: MAX_CONCURRENCY }, () => deferred<void>());
  const holdRuns = held.map((slot) => pool.concurrency.run(async () => slot.promise));
  await flush();
  assert.equal(pool.concurrency.activeCount, MAX_CONCURRENCY);

  let promptRelease: (() => void) | undefined;
  let promptStarted!: () => void;
  const promptReady = new Promise<void>((resolve) => {
    promptStarted = resolve;
  });
  const listeners = new Set<(event: unknown) => void>();
  const fakeMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    timestamp: 1,
    stopReason: "stop",
  };
  const fakeSession = {
    sessionFile: join(cwd, "sessions", "child.jsonl"),
    isStreaming: false as boolean,
    agent: { state: { messages: [] as unknown[] } },
    subscribe(listener: (event: unknown) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      promptStarted();
      await new Promise<void>((resolve) => {
        promptRelease = resolve;
      });
      fakeSession.isStreaming = false;
      fakeSession.agent.state.messages.push(fakeMessage);
      for (const listener of [...listeners]) {
        listener({ type: "message_start", message: { ...fakeMessage } });
        listener({ type: "message_end", message: { ...fakeMessage } });
        listener({ type: "agent_settled" });
      }
    },
    async steer() {},
    async abort() {},
    getLastAssistantText() {
      return "done";
    },
    dispose() {},
  };
  const previousFactory = spawnChildSession.__createChild;
  spawnChildSession.__createChild = async () => ({
    session: fakeSession as never,
    dispose: () => fakeSession.dispose(),
  });

  let registered: RegisteredAgent | undefined;
  const pi = {
    registerTool(tool: RegisteredAgent) {
      registered = tool;
    },
  } as unknown as ExtensionAPI;
  registerAgentTool(pi);

  try {
    assert.ok(registered);
    const result = await registered.execute(
      "call-1",
      { description: "wait for capacity", prompt: "work", subagent_type: "test-agent" },
      undefined,
      undefined,
      context(cwd),
    );
    const jobId = result.details.jobId;
    assert.equal(pool.registry.get(jobId)?.status, "queued");
    assert.equal(pool.liveChildren.has(jobId), false);
    assert.equal(result.details.status, "queued");
    assert.equal(
      result.content[0]?.text,
      "Agent test-agent (" + jobId + ") is running. Take a rest while the agent works. Do not poll agent tools or use sleep-based waiting. Simply end your response and let the agents notify you when they finish.",
    );

    // Free one gate slot. The queued background operation is admitted, marks
    // running in spawnWithControl, and publishes its live control.
    held[0]!.resolve();
    await promptReady;
    assert.equal(pool.registry.get(jobId)?.status, "running");
    assert.equal(pool.liveChildren.has(jobId), true);

    promptRelease!();
    await flush();
    assert.equal(pool.registry.get(jobId)?.status, "completed");
    assert.equal(pool.liveChildren.has(jobId), false);
    const agentId = jobId!.replace(/^job-/, "");
    const agentManifest = homeAgentManifestFile(encodeProjectId(cwd), "root-session", agentId);
    const eventLog = agentManifest.replace("agent.json", "events.jsonl");
    assert.equal(existsSync(agentManifest), true);
    const persistedAgent = JSON.parse(readFileSync(agentManifest, "utf8")) as { status: string; piSessionId: string };
    assert.equal(persistedAgent.status, "completed");
    assert.equal(persistedAgent.piSessionId.startsWith("job-"), false);
    assert.equal(readFileSync(eventLog, "utf8").trim().split("\n").length >= 5, true);
    assert.equal(statSync(agentManifest).mode & 0o777, 0o600);
  } finally {
    spawnChildSession.__createChild = previousFactory;
    // Release every held slot so no gate waiter is left dangling.
    for (const slot of held) slot.resolve();
    await Promise.allSettled(holdRuns);
    await flush();
    rmSync(cwd, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.PI_CODE_TEST_HOME;
    else process.env.PI_CODE_TEST_HOME = previousHome;
  }
});

/**
 * Red-phase regression gate for the spawn freeze: one root background agent
 * call must rescan the home event logs at most once (the pool construction).
 * Previously every spawn paid ~9-14 full synchronous rescans on the tool-call
 * stack because registry lookups and lifecycle writes reloaded every log.
 */
test("one root agent call performs at most one authoritative registry load", async () => {
  const previousHome = process.env.PI_CODE_TEST_HOME;
  process.env.PI_CODE_TEST_HOME = mkdtempSync(join(tmpdir(), "pi-code-spawn-load-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-spawn-load-"));
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "agents", "test-agent.md"),
    "---\nname: test-agent\ndescription: Test agent\n---\ntest body",
    "utf8",
  );
  // Seed several persisted event folders so every full-history rescan is
  // non-trivial; the probe below must not pay them again.
  const pool = getChildPool(cwd, "root-session");
  for (let index = 0; index < 5; index += 1) {
    pool.registry.createJob(createJob({
      jobId: `seeded-${index}`,
      parentSessionId: "root-session",
      status: "completed",
      description: `seed ${index}`,
      subagentType: "test-agent",
    }));
  }

  const listeners = new Set<(event: unknown) => void>();
  const fakeMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    timestamp: 1,
    stopReason: "stop",
  };
  const fakeSession = {
    sessionFile: join(cwd, "sessions", "child.jsonl"),
    isStreaming: false as boolean,
    agent: { state: { messages: [] as unknown[] } },
    subscribe(listener: (event: unknown) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      fakeSession.isStreaming = false;
      fakeSession.agent.state.messages.push(fakeMessage);
      for (const listener of [...listeners]) {
        listener({ type: "message_start", message: { ...fakeMessage } });
        listener({ type: "message_end", message: { ...fakeMessage } });
        listener({ type: "agent_settled" });
      }
    },
    async steer() {},
    async abort() {},
    getLastAssistantText() {
      return "done";
    },
    dispose() {},
  };
  const previousFactory = spawnChildSession.__createChild;
  spawnChildSession.__createChild = async () => ({
    session: fakeSession as never,
    dispose: () => fakeSession.dispose(),
  });

  let registered: RegisteredAgent | undefined;
  const pi = {
    registerTool(tool: RegisteredAgent) {
      registered = tool;
    },
  } as unknown as ExtensionAPI;
  registerAgentTool(pi);

  const logRoot = mkdtempSync(join(tmpdir(), "pi-code-spawn-load-log-"));
  const logger = createSessionLogger({
    projectId: "project",
    rootSessionId: "root-session",
    eventsPath: join(logRoot, "events.jsonl"),
    errorsPath: join(logRoot, "errors.jsonl"),
  });
  try {
    assert.ok(registered);
    await runWithLogContext(logger, async () => {
      const result = await registered!.execute(
        "call",
        { description: "work", prompt: "work", subagent_type: "test-agent" },
        undefined,
        undefined,
        context(cwd),
      );
      assert.ok(result.details.jobId);
      await flush();
      await flush();
      assert.equal(pool.registry.get(result.details.jobId!)?.status, "completed");
    });
    const records = readFileSync(join(logRoot, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const loadStarts = records.filter(
      (record) => record.operation === REGISTRY_OPERATIONS.AGENT_LOAD && record.phase === "before",
    );
    // The pool was constructed before the probe (one construction load). The
    // spawn itself, from getChildPool reuse through queued->running admission,
    // must never rescan the home event logs again.
    assert.equal(loadStarts.length, 0, "a full spawn must not rescan home beyond pool construction");
  } finally {
    spawnChildSession.__createChild = previousFactory;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(logRoot, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.PI_CODE_TEST_HOME;
    else process.env.PI_CODE_TEST_HOME = previousHome;
  }
});
