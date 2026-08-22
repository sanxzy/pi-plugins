import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyHomeModelOverrides,
  homeModelsFileForAgentDir,
} from "../src/shared/home-model-overrides.ts";

function tempAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-c2-home-overrides-"));
}

test("homeModelsFileForAgentDir points at the agent dir's models.json", () => {
  const dir = tempAgentDir();
  try {
    assert.equal(homeModelsFileForAgentDir(dir), join(dir, "models.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("merges modelOverrides into matching extension-registered models", () => {
  const config = {
    models: [
      { id: "gpt-5.6-luna", name: "Luna", contextWindow: 1_050_000 },
      { id: "other", name: "Other", contextWindow: 100_000 },
    ],
  };
  const merged = applyHomeModelOverrides("openai-codex", config as never, {
    providers: {
      "openai-codex": { modelOverrides: { "gpt-5.6-luna": { contextWindow: 260_000 } } },
    },
  });
  const luna = merged.models.find((m: { id: string }) => m.id === "gpt-5.6-luna");
  const other = merged.models.find((m: { id: string }) => m.id === "other");
  assert.equal(luna.contextWindow, 260_000);
  assert.equal(luna.name, "Luna", "non-overridden fields stay untouched");
  assert.equal(other.contextWindow, 100_000, "models without overrides pass through");
});

test("a provider without overrides is returned unchanged", () => {
  const config = { models: [{ id: "x", contextWindow: 5 }] };
  const merged = applyHomeModelOverrides("nope-provider", config as never, {
    providers: { "openai-codex": { modelOverrides: { y: { contextWindow: 1 } } } },
  });
  assert.deepEqual(merged.models[0]!.contextWindow, 5);
});

test("override fields beyond contextWindow are applied (reasoning, maxTokens)", () => {
  const config = { models: [{ id: "m", reasoning: false, maxTokens: 1 }] };
  const merged = applyHomeModelOverrides("p", config as never, {
    providers: { p: { modelOverrides: { m: { reasoning: true, maxTokens: 99 } } } },
  });
  assert.equal(merged.models[0]!.reasoning, true);
  assert.equal(merged.models[0]!.maxTokens, 99);
});

test("reads the real agent-dir file when given a path loader", async () => {
  const dir = tempAgentDir();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({ providers: { "openai-codex": { modelOverrides: { "gpt-5.6-luna": { contextWindow: 260_000 } } } } }),
    );
    const parsed = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
    assert.ok(parsed.providers["openai-codex"].modelOverrides["gpt-5.6-luna"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
