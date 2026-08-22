import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import type { ChildLiveSnapshot } from "@xzy-ai/core";
import { clearModelGroupsCache, getModelGroups, publishChildModelBinding, releaseChildModelBinding, saveModelGroups } from "@xzy-ai/runtime";
import { childFooterInfo } from "../src/registrations/footer.ts";

function snapshot(contextTokens?: number): ChildLiveSnapshot {
  return {
    status: "running",
    settled: false,
    transcript: [],
    counters: {
      toolUses: 0,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0.001,
    },
    ...(contextTokens === undefined ? {} : { contextTokens }),
  };
}

const PARENT_MODEL = { provider: "opencode-go", id: "ox-alpha-free", reasoning: true, contextWindow: 450_000 };

function ctx(entries: readonly unknown[] = []): ExtensionContext {
  return ctxWithUsage(undefined, entries);
}

function ctxWithUsage(contextWindow: number | undefined, entries: readonly unknown[] = []): ExtensionContext {
  return {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp/project",
    model: PARENT_MODEL,
    getContextUsage: () => (contextWindow === undefined ? undefined : { contextWindow }),
    sessionManager: {
      getSessionId: () => "root-session",
      getSessionFile: () => "/tmp/project/s.jsonl",
      getLeafId: () => undefined,
      getEntries: () => entries,
      getCwd: () => "/tmp/project",
      getSessionName: () => "root",
    },
  } as unknown as ExtensionContext;
}

function footerData(): ReadonlyFooterDataProvider {
  return {
    getGitBranch: () => null,
    getAvailableProviderCount: () => 2,
    getExtensionStatuses: () => [],
    onBranchChange: () => () => {},
  } as unknown as ReadonlyFooterDataProvider;
}



test("child footer uses current context tokens instead of cumulative usage counters", () => {
  try {
    publishChildModelBinding("job-context", {
      kind: "pinned",
      provider: "openai-codex",
      modelId: "gpt-5.6-luna",
      contextWindow: 260_000,
    });
    const snapshotWithCumulativeUsage = {
      ...snapshot(52_000),
      counters: {
        toolUses: 0,
        inputTokens: 179_000,
        outputTokens: 914,
        cacheReadTokens: 325_000,
        cacheWriteTokens: 0,
        cost: 0.043,
      },
    };
    const info = childFooterInfo(snapshotWithCumulativeUsage, ctx(), footerData(), "job-context");
    assert.equal(info.contextPercent, 20, "percentage must use the current child context, not lifetime counters");
    assert.equal(info.contextWindow, 260_000);
  } finally {
    releaseChildModelBinding("job-context");
  }
});

test("child footer prefers the registry's resolved group identity over the parent model", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-c2-footer-model-"));
  try {
    process.env.PI_C2_TEST_HOME = home;
    process.env.PI_C2_HOME = home;
    clearModelGroupsCache();
    assert.equal(saveModelGroups({
      groups: [{ id: "beta", name: "Beta Group", mode: "round-robin", quarantineTurns: 5, models: [{ ref: "prov/two" }, { ref: "prov/one" }] }],
      activeGroupId: undefined,
    }).ok, true);
    publishChildModelBinding("job-view", {
      kind: "group",
      groupId: "beta",
      provider: "prov",
      modelId: "two",
      thinking: "high",
    });
    const info = childFooterInfo(snapshot(), ctx(), footerData(), "job-view");
    assert.equal(info.model, "two");
    assert.equal(info.provider, "prov");
    assert.equal(info.thinkingLevel, "high");
    assert.equal(info.modelGroupName, "Beta Group", "an explicitly bound group is labelled by its own name");
  } finally {
    releaseChildModelBinding("job-view");
    delete process.env.PI_C2_TEST_HOME;
    delete process.env.PI_C2_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("child footer uses a pinned registry entry's catalog identity and chain thinking", () => {
  try {
    publishChildModelBinding("job-pin", {
      kind: "pinned",
      provider: "openai-codex",
      modelId: "gpt-5.6-luna",
      thinking: "xhigh",
      reasoning: true,
      contextWindow: 400_000,
    });
    const info = childFooterInfo(snapshot(), ctxWithUsage(450_000), footerData(), "job-pin");
    assert.equal(info.model, "gpt-5.6-luna");
    assert.equal(info.provider, "openai-codex");
    assert.equal(info.thinkingLevel, "xhigh");
    assert.equal(info.modelGroupName, undefined);
    assert.equal(info.contextWindow, 400_000, "the child's own model window beats the parent's usage context");
    assert.equal(info.reasoning, true, "reasoning capability drives the thinking suffix");
  } finally {
    releaseChildModelBinding("job-pin");
  }
});

test("an inherited publication shows the parent-side resolved model it inherited", () => {
  try {
    publishChildModelBinding("job-inherit", {
      kind: "inherit",
      provider: "opencode-go",
      modelId: "ox-alpha-free",
      thinking: "max",
    });
    const info = childFooterInfo(snapshot(), ctx(), footerData(), "job-inherit");
    assert.equal(info.model, "ox-alpha-free");
    assert.equal(info.provider, "opencode-go");
    assert.equal(info.thinkingLevel, "max");
  } finally {
    releaseChildModelBinding("job-inherit");
  }
});

test("child footer never labels a non-group binding with the transient active group", () => {
  // Host bridge reports an ACTIVE ox-group (the parent's selection).
  (globalThis as Record<symbol, unknown>)[Symbol.for("pi-c2.model-groups")] = {
    list: () => [{ id: "ox-group", name: "ox group", active: true }],
  };
  try {
    publishChildModelBinding("job-pin2", {
      kind: "pinned",
      provider: "openai-codex",
      modelId: "gpt-5.6-luna",
      thinking: "xhigh",
      reasoning: true,
    });
    const info = childFooterInfo(snapshot(), ctx(), footerData(), "job-pin2");
    assert.equal(info.modelGroupName, undefined, "transient selection must not label a pinned child");
    assert.equal(info.model, "gpt-5.6-luna");
    assert.equal(info.thinkingLevel, "xhigh");
  } finally {
    releaseChildModelBinding("job-pin2");
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-c2.model-groups")];
  }
});

test("without a registry entry the footer falls back to the parent context model", () => {
  const info = childFooterInfo(snapshot(), ctx(), footerData(), "job-unknown");
  assert.equal(info.model, "ox-alpha-free");
  assert.equal(info.provider, "opencode-go");
});
