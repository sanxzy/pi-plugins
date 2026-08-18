import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveExactChildModel } from "../src/infrastructure/pi-sdk/child-model.ts";

interface FakeModel {
  id: string;
  provider: string;
  name: string;
  api: string;
  baseUrl: string;
  reasoning: boolean;
  input: string[];
  cost: Record<string, unknown>;
  contextWindow: number;
  maxTokens: number;
}

function model(id: string, provider = "anthropic"): FakeModel {
  return {
    id,
    provider,
    name: id,
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  };
}

const CATALOG: FakeModel[] = [
  model("deepseek-v4-flash", "commandcode"),
  model("deepseek-v4-pro", "commandcode"),
  model("claude-sonnet-4-5"),
];

function runtimeWith(models: readonly FakeModel[]): { getModels(): readonly FakeModel[] } {
  return { getModels: () => models };
}

test("an exact provider/model reference resolves as-is", () => {
  const resolved = resolveExactChildModel("commandcode/deepseek-v4-flash", runtimeWith(CATALOG));
  assert.ok(resolved, "exact reference resolves");
  assert.equal(resolved.provider, "commandcode");
  assert.equal(resolved.id, "deepseek-v4-flash");
});

test("a bare model id resolves only on an exact id match", () => {
  const resolved = resolveExactChildModel("deepseek-v4-pro", runtimeWith(CATALOG));
  assert.ok(resolved);
  assert.equal(resolved.id, "deepseek-v4-pro");
});

test("an ambiguous bare id across providers does not resolve (no auto-correction)", () => {
  const catalog = [...CATALOG, model("deepseek-v4-flash", "openai")];
  assert.equal(resolveExactChildModel("deepseek-v4-flash", runtimeWith(catalog)), undefined);
});

test("a partial or fuzzy reference never resolves (no normalization)", () => {
  // "deepseek" is a prefix of real ids but not an exact id; it must not match.
  assert.equal(resolveExactChildModel("deepseek", runtimeWith(CATALOG)), undefined);
  // "commandcode/deepseek" is missing the model id segment; no match.
  assert.equal(resolveExactChildModel("commandcode/deepseek", runtimeWith(CATALOG)), undefined);
  // Case differences are not corrected.
  assert.equal(resolveExactChildModel("CommandCode/deepseek-v4-flash", runtimeWith(CATALOG)), undefined);
});

test("an unknown reference resolves to undefined (caller fails the child)", () => {
  assert.equal(resolveExactChildModel("commandcode/does-not-exist", runtimeWith(CATALOG)), undefined);
  assert.equal(resolveExactChildModel("openai/gpt-5", runtimeWith(CATALOG)), undefined);
});

test("an empty or whitespace-only reference never resolves", () => {
  assert.equal(resolveExactChildModel("", runtimeWith(CATALOG)), undefined);
  assert.equal(resolveExactChildModel("   ", runtimeWith(CATALOG)), undefined);
});

test("a missing runtime never resolves", () => {
  assert.equal(resolveExactChildModel("commandcode/deepseek-v4-flash", undefined), undefined);
});
