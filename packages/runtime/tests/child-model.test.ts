import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveChildModelMapping, resolveChildThinkingMapping, resolveExactChildModel } from "../src/infrastructure/pi-sdk/child-model.ts";

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

const CONFIG_PATH = "/home/user/.pi/agent/pi-c2/config.json";

function mapping(options: Partial<Parameters<typeof resolveChildModelMapping>[0]> = {}): ReturnType<typeof resolveChildModelMapping> {
  return resolveChildModelMapping({
    frontmatterModel: undefined,
    globalModel: undefined,
    agentName: "explore",
    modelRuntime: runtimeWith(CATALOG),
    globalConfigPath: CONFIG_PATH,
    ...options,
  });
}

test("mapping: frontmatter model wins over the global model", () => {
  const result = mapping({
    frontmatterModel: "commandcode/deepseek-v4-pro",
    globalModel: "commandcode/deepseek-v4-flash",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.model?.id, "deepseek-v4-pro");
});

test("mapping: global model applies when the frontmatter key is absent", () => {
  const result = mapping({ globalModel: "commandcode/deepseek-v4-flash" });
  assert.equal(result.error, undefined);
  assert.equal(result.model?.provider, "commandcode");
  assert.equal(result.model?.id, "deepseek-v4-flash");
});

test("mapping: no configured value at either level leaves the parent model", () => {
  const result = mapping();
  assert.equal(result.error, undefined);
  assert.equal(result.model, undefined, "caller keeps the parent model");
});

test("mapping: unresolvable frontmatter model errors without falling back", () => {
  const result = mapping({ frontmatterModel: "commandcode/dummy-nonexistent-model" });
  assert.equal(result.model, undefined);
  assert.match(result.error ?? "", /Agent "explore" declares model "commandcode\/dummy-nonexistent-model"/);
  assert.match(result.error ?? "", /does not match any available model exactly/);
});

test("mapping: unresolvable global model errors with the config path", () => {
  const result = mapping({ globalModel: "commandcode/not-a-model" });
  assert.equal(result.model, undefined);
  assert.match(result.error ?? "", /Global agent model "commandcode\/not-a-model"/);
  assert.match(result.error ?? "", new RegExp(CONFIG_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.error ?? "", /agents\.model/);
});

test("mapping: a resolvable global model is used exactly as-is with no normalization", () => {
  const result = mapping({ globalModel: "commandcode/deepseek-v4-flash" });
  assert.equal(result.model?.provider, "commandcode");
  assert.equal(result.model?.id, "deepseek-v4-flash");
});

function thinkingMapping(options: Partial<Parameters<typeof resolveChildThinkingMapping>[0]> = {}): ReturnType<typeof resolveChildThinkingMapping> {
  return resolveChildThinkingMapping({
    frontmatterThinking: undefined,
    globalThinking: undefined,
    globalConfigPath: CONFIG_PATH,
    ...options,
  });
}

test("thinking mapping: frontmatter thinking wins over the global level", () => {
  const result = thinkingMapping({ frontmatterThinking: "max", globalThinking: "high" });
  assert.equal(result.error, undefined);
  assert.equal(result.thinking, "max");
});

test("thinking mapping: global level applies when the frontmatter key is absent", () => {
  const result = thinkingMapping({ globalThinking: "high" });
  assert.equal(result.error, undefined);
  assert.equal(result.thinking, "high");
});

test("thinking mapping: no configured value leaves the SDK default", () => {
  const result = thinkingMapping();
  assert.equal(result.error, undefined);
  assert.equal(result.thinking, undefined, "caller keeps the SDK default");
});

test("thinking mapping: an invalid global level errors with the config path", () => {
  const result = thinkingMapping({ globalThinking: "super-duper" });
  assert.equal(result.thinking, undefined);
  assert.match(result.error ?? "", /Global agent thinking "super-duper"/);
  assert.match(result.error ?? "", new RegExp(CONFIG_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.error ?? "", /agents\.thinking/);
});

test("thinking mapping: a whitespace-padded valid level is trimmed before use", () => {
  const result = thinkingMapping({ globalThinking: "  high  " });
  assert.equal(result.thinking, "high");
});

// --- Child model binding resolution (frontmatter > config > inherit) -------

import {
  parseModelBinding,
  resolveChildModelBinding,
  type ChildModelBinding,
} from "../src/infrastructure/pi-sdk/child-model.ts";

test("parse: a plain reference parses as a model binding", () => {
  assert.deepEqual(parseModelBinding("commandcode/deepseek-v4-flash"), { kind: "model", reference: "commandcode/deepseek-v4-flash" });
});

test("parse: a group: prefixed reference parses as a group binding", () => {
  assert.deepEqual(parseModelBinding("group:ox-group"), { kind: "group", groupId: "ox-group" });
  assert.deepEqual(parseModelBinding("  group:helper  "), { kind: "group", groupId: "helper" });
});

test("parse: an empty or whitespace-only value parses as no binding", () => {
  assert.equal(parseModelBinding(undefined), undefined);
  assert.equal(parseModelBinding(""), undefined);
  assert.equal(parseModelBinding("   "), undefined);
});

test("parse: a blank group id is preserved for the resolver to reject", () => {
  assert.deepEqual(parseModelBinding("group:"), { kind: "group", groupId: "" });
  assert.deepEqual(parseModelBinding("group:   "), { kind: "group", groupId: "" });
});

function binding(options: Partial<Parameters<typeof resolveChildModelBinding>[0]> = {}): { ok: true; binding: ChildModelBinding } | { ok: false; error: string } {
  return resolveChildModelBinding({
    frontmatterModel: undefined,
    globalModel: undefined,
    agentName: "explore",
    modelRuntime: runtimeWith(CATALOG),
    globalConfigPath: CONFIG_PATH,
    findGroup: (id: string) => (id === "ox-group" || id === "helper" ? { id } : undefined),
    ...options,
  });
}

test("binding: a resolvable frontmatter group binds the child to that group", () => {
  const result = binding({ frontmatterModel: "group:ox-group" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.binding, { kind: "group", groupId: "ox-group" });
});

test("binding: an unknown frontmatter group errors without falling back", () => {
  const result = binding({ frontmatterModel: "group:missing-group" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /Agent "explore" declares model "group:missing-group"/);
    assert.match(result.error, /unknown model group/i);
  }
});

test("binding: a resolvable frontmatter model still pins exactly as before", () => {
  const result = binding({ frontmatterModel: "claude-sonnet-4-5" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.binding, { kind: "model", model: { provider: "anthropic", id: "claude-sonnet-4-5" } });
});

test("binding: an unknown frontmatter model errors without falling back", () => {
  const result = binding({ frontmatterModel: "commandcode/dummy-nonexistent-model" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /does not match any available model exactly/);
});

test("binding: a global group binds when the frontmatter key is absent", () => {
  const result = binding({ globalModel: "group:helper" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.binding, { kind: "group", groupId: "helper" });
});

test("binding: an unknown global group errors with the config path", () => {
  const result = binding({ globalModel: "group:missing-group" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /Global agent model "group:missing-group"/);
    assert.match(result.error, /unknown model group/i);
    assert.match(result.error, new RegExp(CONFIG_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("binding: a global plain model still pins when the frontmatter key is absent", () => {
  const result = binding({ globalModel: "commandcode/deepseek-v4-pro" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.binding, { kind: "model", model: { provider: "commandcode", id: "deepseek-v4-pro" } });
});

test("binding: no configured value at either level inherits the parent model", () => {
  const result = binding();
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.binding, { kind: "inherit" });
});

test("binding: the frontmatter group wins over a configured global model", () => {
  const result = binding({ frontmatterModel: "group:ox-group", globalModel: "commandcode/deepseek-v4-flash" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.binding, { kind: "group", groupId: "ox-group" });
});
