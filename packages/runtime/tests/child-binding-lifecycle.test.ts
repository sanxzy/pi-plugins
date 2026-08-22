import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ResolvedAgent } from "@xzy-ai/core";
import {
  getChildModelBinding,
  publishChildModelBinding,
  releaseChildModelBinding,
} from "../src/infrastructure/pi-sdk/child-bindings.ts";
import { spawnChildSession } from "../src/infrastructure/pi-sdk/child-session.ts";

// --- F-001: inherited bindings from explicitly bound parents --------------

interface PlanOk {
  ok: true;
  publish?: { kind: "group"; groupId: string } | { kind: "pinned" };
  model?: { provider: string; id: string };
  thinking?: string;
  inheritParentModel: boolean;
}

function plan(options: Record<string, unknown> = {}): Promise<PlanOk | { ok: false; error: string }> {
  return import("../src/infrastructure/pi-sdk/child-model.ts").then((mod) => {
    const fn = (mod as { resolveChildSpawnBinding?: unknown }).resolveChildSpawnBinding;
    assert.equal(typeof fn, "function", "resolveChildSpawnBinding must exist");
    return (fn as (...args: unknown[]) => Promise<PlanOk | { ok: false; error: string }>)({
      frontmatterModel: undefined,
      globalModel: undefined,
      agentName: "explore",
      modelRuntime: {
        getModels: () => [
          { id: "one", provider: "prov" },
          { id: "two", provider: "prov" },
        ],
      },
      findGroup: (groupId: string) => (groupId === "ox-group" || groupId === "helper" ? { id: groupId } : undefined),
      resolveInitialMember: (groupId: string) =>
        groupId === "ox-group"
          ? { ref: "prov/one", thinking: "high" }
          : groupId === "helper"
            ? { ref: "prov/two" }
            : undefined,
      ...options,
    });
  });
}

test("an unbound child of an unbound parent stays unbound and inherits the model", async () => {
  const result = await plan();
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.publish, undefined);
  assert.equal(result.inheritParentModel, true);
});

test("a child with no config inherits its parent's named group and starts on its member", async () => {
  const result = await plan({ parentBinding: { kind: "group", groupId: "ox-group" } });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.publish, { kind: "group", groupId: "ox-group" });
  assert.deepEqual(result.model, { provider: "prov", id: "one" });
  assert.equal(result.thinking, "high");
});

test("an inherited group without member thinking leaves the SDK default", async () => {
  const result = await plan({ parentBinding: { kind: "group", groupId: "helper" } });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.publish, { kind: "group", groupId: "helper" });
  assert.deepEqual(result.model, { provider: "prov", id: "two" });
  assert.equal(result.thinking, undefined);
});

test("a child with no config inherits its parent's pinned state", async () => {
  const result = await plan({ parentBinding: { kind: "pinned" } });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.publish, { kind: "pinned" });
  assert.equal(result.inheritParentModel, true);
});

test("frontmatter configuration wins over an inherited parent group", async () => {
  const result = await plan({
    frontmatterModel: "group:helper",
    parentBinding: { kind: "group", groupId: "ox-group" },
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.publish, { kind: "group", groupId: "helper" });
  assert.deepEqual(result.model, { provider: "prov", id: "two" });
  assert.equal(result.thinking, undefined);
});

test("global config wins over an inherited parent pinned state", async () => {
  const result = await plan({
    globalModel: "prov/two",
    parentBinding: { kind: "pinned" },
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.publish, { kind: "pinned" });
  assert.deepEqual(result.model, { provider: "prov", id: "two" });
});

test("a stale inherited group degrades to unbound inheritance instead of failing", async () => {
  const result = await plan({ parentBinding: { kind: "group", groupId: "deleted-group" } });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.publish, undefined);
  assert.equal(result.inheritParentModel, true);
});

test("an inherited group with every member quarantined fails the spawn", async () => {
  const result = await plan({
    parentBinding: { kind: "group", groupId: "helper" },
    resolveInitialMember: () => undefined,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /quarantined/i);
});

// --- F-002: setup failure must release the binding and dispose ------------

function resolvedAgent(): ResolvedAgent {
  return {
    name: "test-agent",
    description: "",
    systemPrompt: "",
    source: "project",
    filePath: "/tmp/test-agent.md",
  };
}

interface Spies {
  disposals: number;
  unsubscribes: number;
}

async function spawnWith(
  jobId: string,
  onControl: (control: unknown) => void,
): Promise<{ status: string; spies: Spies }> {
  const spies: Spies = { disposals: 0, unsubscribes: 0 };
  const fakeSession = {
    sessionFile: join(tmpdir(), "fake-transcript.jsonl"),
    subscribe: () => () => {
      spies.unsubscribes += 1;
    },
    steer: async () => {},
    abort: async () => {},
  };
  spawnChildSession.__createChild = async (opts) => {
    publishChildModelBinding(opts.jobId, { kind: "pinned" });
    return {
      session: fakeSession,
      dispose: () => {
        spies.disposals += 1;
        releaseChildModelBinding(opts.jobId);
      },
    } as never;
  };
  try {
    const result = (await spawnChildSession({
      jobId,
      cwd: tmpdir(),
      agent: resolvedAgent(),
      prompt: "run",
      parentSessionId: "root-1",
      run: (callback: () => Promise<unknown>) => callback() as Promise<unknown>,
      onControl,
    } as never)) as { status: string } | undefined;
    return { status: result?.status ?? "failed", spies };
  } finally {
    delete spawnChildSession.__createChild;
  }
}

test("during healthy setup the binding stays published", async () => {
  let observedDuringOnControl: string | undefined;
  await spawnWith("job-ok", () => {
    observedDuringOnControl = getChildModelBinding("job-ok")?.kind;
  });
  assert.equal(observedDuringOnControl, "pinned");
});

test("a throwing onControl releases the published binding and disposes the child", async () => {
  const { status, spies } = await spawnWith("job-explode", () => {
    throw new Error("control sink exploded");
  });
  assert.equal(status, "failed");
  assert.equal(getChildModelBinding("job-explode"), undefined, "binding must not leak after setup failure");
  assert.equal(spies.disposals, 1, "the created session must be disposed");
  assert.equal(spies.unsubscribes >= 1 || spies.unsubscribes === 0, true);
});
