import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createJob, type Job } from "@xzy-ai/core";
import { getChildPool } from "@xzy-ai/runtime";
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
