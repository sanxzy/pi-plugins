import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createJob } from "@xzy-ai/core";
import { getChildPool, startRootSession } from "@xzy-ai/runtime";
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
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-goal-tools-"));
  try {
    startRootSession({ projectRoot: cwd, sessionId: "root" });
    await run(cwd, tools());
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("registers exactly the five cwd-scoped goal tools", () => {
  const registered = tools();
  assert.deepEqual([...registered.keys()], ["goal_create", "goal_pause", "goal_resume", "goal_status", "goal_clear"]);
  assert.deepEqual(Object.keys(registered.get("goal_create")?.parameters.properties ?? {}), ["prompt", "interval"]);
  // AC2: the schema exposes the hard safety ceiling that bounds the resolved value.
  assert.equal(
    (registered.get("goal_create")?.parameters.properties as Record<string, { maxLength?: number }>).prompt?.maxLength,
    1_000_000,
  );
  assert.deepEqual(Object.keys(registered.get("goal_pause")?.parameters.properties ?? {}), ["reason"]);
  for (const name of ["goal_resume", "goal_status"]) {
    assert.deepEqual(Object.keys(registered.get(name)?.parameters.properties ?? {}), []);
  }
  assert.deepEqual(Object.keys(registered.get("goal_clear")?.parameters.properties ?? {}), ["isComplete"]);
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

test("goal_create treats a leading duration as scheduling metadata when interval is omitted", async () => {
  await withCwd(async (cwd, registered) => {
    const result = await registered.get("goal_create")!.execute(
      "call",
      { prompt: "2m testing goal, is it working, clear after 2nd triggered" },
      undefined,
      undefined,
      context(cwd),
    );
    const goal = (result.details as { goal: { prompt: string; intervalMs: number } }).goal;
    assert.equal(goal.prompt, "testing goal, is it working, clear after 2nd triggered");
    assert.equal(goal.intervalMs, 120_000);
    assert.doesNotMatch(text(result), /Prompt: 2m/);
    assert.match(text(result), /Prompt: testing goal/);
    assert.match(text(result), /Interval: 120000ms/);
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

    const declined = await registered.get("goal_clear")!.execute("call", { isComplete: false }, undefined, undefined, ctx);
    assert.match(text(declined), /not yet complete|not cleared/i);
    assert.match(text(declined), /first|goal context/i);
    const stillPresent = await registered.get("goal_status")!.execute("call", {}, undefined, undefined, ctx);
    assert.match(text(stillPresent), /active/);

    const cleared = await registered.get("goal_clear")!.execute("call", { isComplete: true }, undefined, undefined, ctx);
    assert.match(text(cleared), /completed|congrat/i);

    const missing = await registered.get("goal_clear")!.execute("call", { isComplete: true }, undefined, undefined, ctx);
    assert.match(text(missing), /no goal/i);
  });
});

test("goal_clear false preserves paused context and explains how to finish", async () => {
  await withCwd(async (cwd, registered) => {
    const ctx = context(cwd);
    await registered.get("goal_create")!.execute("call", { prompt: "finish the migration" }, undefined, undefined, ctx);
    await registered.get("goal_pause")!.execute("call", { reason: "waiting for verification" }, undefined, undefined, ctx);

    const result = await registered.get("goal_clear")!.execute("call", { isComplete: false }, undefined, undefined, ctx);
    assert.match(text(result), /not yet complete/i);
    assert.match(text(result), /waiting for verification/);
    assert.match(text(result), /isComplete: true|isComplete.*true/i);
    const status = await registered.get("goal_status")!.execute("call", {}, undefined, undefined, ctx);
    assert.match(text(status), /paused/);
    assert.match(text(status), /finish the migration/);
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
      subagentType: "test-agent",
      sessionId: "child-session",
    }));
    const result = await registered.get("goal_status")!.execute("call", {}, undefined, undefined, context(cwd, "child-session"));
    assert.match(text(result), /child sessions/i);
  });
});
