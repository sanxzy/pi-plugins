import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createJob, MAX_CONCURRENCY, type Job } from "@xzy-ai/core";
import { getChildPool, spawnChildSession } from "@xzy-ai/runtime";
import { registerAgentTool } from "../src/registrations/agent.ts";
import { registerCancelTool } from "../src/registrations/cancel.ts";
import { registerJobsTool } from "../src/registrations/jobs.ts";
import { registerStatusTool } from "../src/registrations/status.ts";

type Tool = {
  name: string;
  execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
};

function context(cwd: string, sessionId: string): ExtensionContext {
  return {
    mode: "tui",
    hasUI: true,
    cwd,
    model: {} as ExtensionContext["model"],
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => join(cwd, "sessions", `${sessionId}.jsonl`),
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

function register(registerTool: (pi: ExtensionAPI) => void): Tool {
  let tool: Tool | undefined;
  registerTool({
    registerTool(candidate: Tool) {
      tool = candidate;
    },
  } as unknown as ExtensionAPI);
  assert.ok(tool);
  return tool;
}

function job(jobId: string, parentSessionId: string, status: Job["status"], parentJobId?: string): Job {
  return createJob({
    jobId,
    parentSessionId,
    parentJobId,
    rootJobId: parentJobId ?? jobId,
    depth: parentJobId === undefined ? 0 : 1,
    status,
    description: `${parentSessionId}:${jobId}`,
    subagentType: "test-agent",
    sessionId: jobId,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

async function withIsolationPool(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-tools-isolation-"));
  try {
    const pool = getChildPool(cwd, "root-a");
    pool.registry.createJob(job("a-running", "root-a", "running"));
    pool.registry.createJob(job("a-completed", "root-a", "completed"));
    pool.registry.createJob(job("a-cancelled", "root-a", "cancelled"));
    pool.registry.createJob(job("b-running", "root-b", "running"));
    pool.registry.createJob(job("b-completed", "root-b", "completed"));
    pool.registry.createJob(job("b-cancelled", "root-b", "cancelled"));
    await run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("agent_jobs lists only the active parent session's running and historical descendants", async () => {
  await withIsolationPool(async (cwd) => {
    const tool = register(registerJobsTool);
    const result = await tool.execute("call", {}, undefined, undefined, context(cwd, "root-a"));
    const jobs = result.details.jobs as Array<{ jobId: string }>;
    assert.deepEqual(jobs.map((entry) => entry.jobId), ["a-running", "a-completed", "a-cancelled"]);
    assert.equal(result.content[0]?.text.includes("b-running"), false);
    assert.equal(result.content[0]?.text.includes("b-completed"), false);
    assert.equal(result.content[0]?.text.includes("b-cancelled"), false);
  });
});

test("agent_jobs reports active jobs and discourages polling or sleep-based waiting", async () => {
  await withIsolationPool(async (cwd) => {
    const tool = register(registerJobsTool);
    const result = await tool.execute("call", {}, undefined, undefined, context(cwd, "root-a"));
    const text = result.content[0]?.text ?? "";
    assert.match(text, /Subagent jobs:/);
    assert.match(text, /a-running: running/);
    assert.match(text, /1 subagent job\(s\) are still running/);
    assert.match(text, /Do not poll agent tools or use sleep-based waiting/);
    assert.match(text, /let the agents notify you when they settle/);
  });
});

test("agent_status for a running job mentions the subagent type and discourages polling", async () => {
  await withIsolationPool(async (cwd) => {
    const tool = register(registerStatusTool);
    const result = await tool.execute("call", { job_id: "a-running" }, undefined, undefined, context(cwd, "root-a"));
    assert.equal(
      result.content[0]?.text,
      "Agent test-agent (a-running) is running. Take a rest while the agent works. Do not poll agent tools or use sleep-based waiting. Simply end your response and let the agents notify you when they finish.",
    );
    assert.equal((result.details as { status: string }).status, "running");
  });
});

test("agent_status treats another parent session's job id as unknown", async () => {
  await withIsolationPool(async (cwd) => {
    const tool = register(registerStatusTool);
    const result = await tool.execute("call", { job_id: "b-completed" }, undefined, undefined, context(cwd, "root-a"));
    assert.equal(result.content[0]?.text, "Error: unknown job id: b-completed");
    assert.deepEqual(result.details, { status: "failed", reason: "unknown job id" });
  });
});

test("agent_cancel treats another parent session's job id as unknown without aborting", async () => {
  await withIsolationPool(async (cwd) => {
    const pool = getChildPool(cwd);
    let aborts = 0;
    pool.liveChildren.set("b-running", {
      sessionFile: undefined,
      steer: async () => {},
      abort: async () => {
        aborts++;
      },
    });
    const tool = register(registerCancelTool);
    const result = await tool.execute("call", { job_id: "b-running" }, undefined, undefined, context(cwd, "root-a"));
    assert.equal(result.content[0]?.text, "Error: unknown job id: b-running");
    assert.deepEqual(result.details, { jobId: "b-running", success: false, reason: "unknown job id" });
    assert.equal(aborts, 0);
    assert.equal(pool.registry.get("b-running")?.status, "running");
  });
});

test("agent rejects an unknown subagent type, including the removed default", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-tools-unknown-agent-"));
  try {
    const tool = register(registerAgentTool);
    const result = await tool.execute(
      "call",
      { description: "unknown", prompt: "do not spawn", subagent_type: "default" },
      undefined,
      undefined,
      context(cwd, "root-a"),
    );
    assert.equal(result.content[0]?.text, "Error: unknown subagent_type: default");
    assert.deepEqual(result.details, { jobId: undefined, reason: "unknown subagent_type" });
    assert.equal(getChildPool(cwd).registry.all().size, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("agent resume remains TUI-only because it runs in background", async () => {
  await withIsolationPool(async (cwd) => {
    const tool = register(registerAgentTool);
    const result = await tool.execute(
      "call",
      { description: "resume", prompt: "continue", subagent_type: "test-agent", agent_id: "a-completed" },
      undefined,
      undefined,
      { ...context(cwd, "root-a"), mode: "print" } as unknown as ExtensionContext,
    );
    assert.equal(result.content[0]?.text, "Error: background agents are available only in TUI mode");
    assert.deepEqual(result.details, { jobId: "a-completed", reason: "background mode is invalid in print mode" });
  });
});

test("agent steer output names the targeted subagent type and remains allowed outside TUI mode", async () => {
  await withIsolationPool(async (cwd) => {
    const pool = getChildPool(cwd);
    let steers = 0;
    pool.liveChildren.set("a-running", {
      sessionFile: undefined,
      steer: async () => {
        steers++;
      },
      abort: async () => {},
    });
    const tool = register(registerAgentTool);
    const result = await tool.execute(
      "call",
      { description: "redirect", prompt: "new direction", subagent_type: "test-agent", agent_id: "a-running" },
      undefined,
      undefined,
      { ...context(cwd, "root-a"), mode: "print" } as unknown as ExtensionContext,
    );
    assert.equal(
      result.content[0]?.text,
      "Steered agent test-agent (a-running). The agent keeps its running context and will notify you when it settles. Take a rest while the agent works. Do not poll agent tools or use sleep-based waiting. Simply end your response and let the agents notify you when they finish.",
    );
    assert.deepEqual(result.details, { jobId: "a-running", status: "running" });
    assert.equal(steers, 1);
  });
});

test("agent resumes a terminal job in place with the same id and transcript", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-tools-resume-agent-"));
  const sessionFile = join(cwd, ".pi", "pi-code", "sessions", "root-a", "original.jsonl");
  mkdirSync(dirname(sessionFile), { recursive: true });
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "agents", "test-agent.md"), "---\nname: test-agent\ndescription: Test agent\n---\ntest body", "utf8");
  const header = { type: "session", version: 3, id: "original", timestamp: "t", cwd };
  const assistant = {
    type: "message",
    id: "m1",
    parentId: null,
    timestamp: "t",
    message: { role: "assistant", content: [{ type: "text", text: "old" }] },
  };
  writeFileSync(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(assistant)}\n`, "utf8");

  const pool = getChildPool(cwd, "root-a");
  pool.registry.createJob(createJob({
    jobId: "original",
    parentSessionId: "root-a",
    sessionId: "original",
    status: "completed",
    description: "old work",
    subagentType: "test-agent",
    sessionFile,
  }));
  const held = Array.from({ length: MAX_CONCURRENCY }, () => deferred<void>());
  const holdRuns = held.map((slot) => pool.concurrency.run(() => slot.promise));
  await flush();
  const previousFactory = spawnChildSession.__createChild;
  spawnChildSession.__createChild = async () => {
    throw new Error("test child should not need to run before assertions");
  };

  try {
    const tool = register(registerAgentTool);
    const result = await tool.execute(
      "call",
      { description: "continue work", prompt: "continue", subagent_type: "test-agent", agent_id: "original" },
      undefined,
      undefined,
      context(cwd, "root-a"),
    );
    const resumeJobId = result.details.jobId as string;
    const resumed = pool.registry.get("original");
    // The resumed run keeps the original job id and transcript path.
    assert.equal(resumeJobId, "original");
    assert.equal(resumed?.status, "queued");
    assert.equal(resumed?.sessionFile, sessionFile);
    assert.equal(existsSync(sessionFile), true);
    assert.equal(
      result.content[0]?.text,
      "Resuming Agent test-agent (original) is running. Take a rest while the agent works. Do not poll agent tools or use sleep-based waiting. Simply end your response and let the agents notify you when they finish.",
    );
    // No duplicate job or transcript copy is created.
    assert.equal(pool.registry.all().size, 1);
  } finally {
    for (const slot of held) slot.resolve();
    await Promise.allSettled(holdRuns);
    await flush();
    spawnChildSession.__createChild = previousFactory;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("agent treats another parent session's agent id as unknown without steering", async () => {
  await withIsolationPool(async (cwd) => {
    const pool = getChildPool(cwd);
    let steers = 0;
    pool.liveChildren.set("b-running", {
      sessionFile: undefined,
      steer: async () => {
        steers++;
      },
      abort: async () => {},
    });
    const tool = register(registerAgentTool);
    const result = await tool.execute(
      "call",
      { description: "hidden", prompt: "do not steer", subagent_type: "test-agent", agent_id: "b-running" },
      undefined,
      undefined,
      context(cwd, "root-a"),
    );
    assert.equal(result.content[0]?.text, "Error: unknown agent id: b-running");
    assert.deepEqual(result.details, { jobId: "b-running", reason: "unknown agent id" });
    assert.equal(steers, 0);
  });
});
