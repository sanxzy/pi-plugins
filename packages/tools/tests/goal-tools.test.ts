import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createJob } from "@xzy-ai/core";
import { getChildPool } from "@xzy-ai/runtime";
import { registerGoalTools } from "../src/registrations/goals.ts";

interface RegisteredTool {
  name: string;
  parameters: { properties?: Record<string, unknown> };
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }>;
}

function context(cwd: string, sessionId = "root"): ExtensionContext {
  return {
    mode: "tui",
    hasUI: true,
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => join(cwd, "sessions", `${sessionId}.jsonl`),
    },
  } as unknown as ExtensionContext;
}

function tools(): Map<string, RegisteredTool> {
  const registered = new Map<string, RegisteredTool>();
  registerGoalTools({
    registerTool(tool: RegisteredTool) {
      registered.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI);
  return registered;
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

async function withCwd(run: (cwd: string, registered: Map<string, RegisteredTool>) => Promise<void>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-goal-tools-"));
  try {
    await run(cwd, tools());
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("registers exactly the five cwd-scoped goal tools", () => {
  const registered = tools();
  assert.deepEqual([...registered.keys()], ["goal_create", "goal_pause", "goal_resume", "goal_status", "goal_clear"]);
  assert.deepEqual(Object.keys(registered.get("goal_create")?.parameters.properties ?? {}), ["prompt", "interval"]);
  assert.deepEqual(Object.keys(registered.get("goal_pause")?.parameters.properties ?? {}), ["reason"]);
  for (const name of ["goal_resume", "goal_status", "goal_clear"]) {
    assert.deepEqual(Object.keys(registered.get(name)?.parameters.properties ?? {}), []);
  }
});

test("goal_create preserves the exact prompt and returns an active record", async () => {
  await withCwd(async (cwd, registered) => {
    const prompt = "  Keep this exact text.\nDo not rewrite me.  ";
    const result = await registered.get("goal_create")!.execute("call", { prompt, interval: "30s" }, undefined, undefined, context(cwd));
    assert.match(text(result), /Goal created/);
    assert.match(text(result), /active/);
    assert.match(text(result), new RegExp(prompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const goal = (result.details as { goal: { prompt: string; intervalMs: number; status: string } }).goal;
    assert.equal(goal.prompt, prompt);
    assert.equal(goal.intervalMs, 30_000);
    assert.equal(goal.status, "active");
  });
});

test("goal lifecycle tools return text-only success and precise errors", async () => {
  await withCwd(async (cwd, registered) => {
    const ctx = context(cwd);
    const pause = await registered.get("goal_pause")!.execute("call", { reason: "waiting on review" }, undefined, undefined, ctx);
    assert.match(text(pause), /no goal/i);

    await registered.get("goal_create")!.execute("call", { prompt: "p" }, undefined, undefined, ctx);
    const paused = await registered.get("goal_pause")!.execute("call", { reason: "waiting on review" }, undefined, undefined, ctx);
    assert.equal(text(paused), "Goal paused: waiting on review");

    const status = await registered.get("goal_status")!.execute("call", {}, undefined, undefined, ctx);
    assert.match(text(status), /paused/);
    assert.match(text(status), /waiting on review/);

    const resumed = await registered.get("goal_resume")!.execute("call", {}, undefined, undefined, ctx);
    assert.equal(text(resumed), "Goal resumed: active");

    const cleared = await registered.get("goal_clear")!.execute("call", {}, undefined, undefined, ctx);
    assert.match(text(cleared), /completed|congrat/i);

    const missing = await registered.get("goal_clear")!.execute("call", {}, undefined, undefined, ctx);
    assert.match(text(missing), /no goal/i);
  });
});

test("goal_create rejects invalid input and duplicate records without rewriting state", async () => {
  await withCwd(async (cwd, registered) => {
    const ctx = context(cwd);
    const invalid = await registered.get("goal_create")!.execute("call", { prompt: "  ", interval: "0m" }, undefined, undefined, ctx);
    assert.match(text(invalid), /Error:/);
    assert.match(text(invalid), /prompt|interval/);

    await registered.get("goal_create")!.execute("call", { prompt: "first" }, undefined, undefined, ctx);
    const duplicate = await registered.get("goal_create")!.execute("call", { prompt: "second" }, undefined, undefined, ctx);
    assert.match(text(duplicate), /clear/i);
    const status = await registered.get("goal_status")!.execute("call", {}, undefined, undefined, ctx);
    assert.match(text(status), /first/);
    assert.doesNotMatch(text(status), /second/);
  });
});

test("goal tools refuse invocation from a registered child session", async () => {
  await withCwd(async (cwd, registered) => {
    const childPool = getChildPool(cwd, "root");
    childPool.registry.createJob(createJob({
      jobId: "child-session",
      parentSessionId: "root",
      rootJobId: "child-session",
      depth: 0,
      status: "running",
      description: "child",
      subagentType: "default",
      sessionId: "child-session",
    }));
    const result = await registered.get("goal_status")!.execute("call", {}, undefined, undefined, context(cwd, "child-session"));
    assert.match(text(result), /main host/i);
  });
});
