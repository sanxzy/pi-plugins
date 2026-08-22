import assert from "node:assert/strict";
import { test } from "node:test";

test("published bindings are readable through the shared symbol key", async () => {
  const { publishChildModelBinding, getChildModelBinding, releaseChildModelBinding, CHILD_MODEL_BINDINGS_KEY } = await import("../src/infrastructure/pi-sdk/child-bindings.ts");
  const api = (globalThis as Record<symbol, unknown>)[Symbol.for(CHILD_MODEL_BINDINGS_KEY)];
  assert.ok(api, "registry is installed on globalThis at import time");
  publishChildModelBinding("job-1", { kind: "group", groupId: "ox-group" });
  publishChildModelBinding("job-2", { kind: "pinned" });
  assert.deepEqual(getChildModelBinding("job-1"), { kind: "group", groupId: "ox-group" });
  assert.deepEqual(getChildModelBinding("job-2"), { kind: "pinned" });
  releaseChildModelBinding("job-1");
  assert.equal(getChildModelBinding("job-1"), undefined);
  assert.deepEqual(getChildModelBinding("job-2"), { kind: "pinned" });
  // Release is idempotent.
  releaseChildModelBinding("job-1");
});

test("republishing a session id replaces its binding", async () => {
  const { publishChildModelBinding, getChildModelBinding } = await import("../src/infrastructure/pi-sdk/child-bindings.ts");
  publishChildModelBinding("job-replace", { kind: "pinned" });
  publishChildModelBinding("job-replace", { kind: "group", groupId: "helper" });
  assert.deepEqual(getChildModelBinding("job-replace"), { kind: "group", groupId: "helper" });
});

test("the registry is bounded and evicts the oldest entries first", async () => {
  const { publishChildModelBinding, getChildModelBinding, MAX_CHILD_MODEL_BINDINGS } = await import("../src/infrastructure/pi-sdk/child-bindings.ts");
  const total = MAX_CHILD_MODEL_BINDINGS + 10;
  for (let i = 0; i < total; i++) {
    publishChildModelBinding(`bulk-${i}`, { kind: "pinned" });
  }
  assert.equal(getChildModelBinding(`bulk-0`), undefined, "oldest entry was evicted");
  assert.equal(getChildModelBinding(`bulk-${total - 1}`)?.kind, "pinned", "newest entry survives");
});

// --- Resolved identity publications (phase 002) ---------------------------

test("publication: a group plan carries member identity and thinking", async () => {
  const { buildChildSpawnPublication } = await import("../src/infrastructure/pi-sdk/child-model.ts");
  const publication = buildChildSpawnPublication({
    plan: {
      ok: true,
      publish: { kind: "group", groupId: "ox-group" },
      model: { provider: "prov", id: "one" },
      thinking: "high",
      inheritParentModel: false,
    },
    sessionModel: { provider: "prov", id: "one", contextWindow: 400_000 },
  });
  assert.deepEqual(publication, {
    kind: "group",
    groupId: "ox-group",
    provider: "prov",
    modelId: "one",
    thinking: "high",
    contextWindow: 400_000,
  });
});

test("publication: a pinned plan carries catalog identity and the chain thinking", async () => {
  const { buildChildSpawnPublication } = await import("../src/infrastructure/pi-sdk/child-model.ts");
  const publication = buildChildSpawnPublication({
    plan: {
      ok: true,
      publish: { kind: "pinned" },
      model: { provider: "openai-codex", id: "gpt-5.6-luna" },
      inheritParentModel: false,
    },
    chainThinking: "xhigh",
  });
  assert.deepEqual(publication, {
    kind: "pinned",
    provider: "openai-codex",
    modelId: "gpt-5.6-luna",
    thinking: "xhigh",
  });
});

test("publication: an inherited plan publishes inherit identity from the parent model", async () => {
  const { buildChildSpawnPublication } = await import("../src/infrastructure/pi-sdk/child-model.ts");
  const publication = buildChildSpawnPublication({
    plan: { ok: true, inheritParentModel: true },
    sessionModel: { provider: "opencode-go", id: "ox-alpha-free" },
    chainThinking: "max",
  });
  assert.deepEqual(publication, {
    kind: "inherit",
    provider: "opencode-go",
    modelId: "ox-alpha-free",
    thinking: "max",
  });
});

test("publication: an inherited plan without any known model stays minimal", async () => {
  const { buildChildSpawnPublication } = await import("../src/infrastructure/pi-sdk/child-model.ts");
  const publication = buildChildSpawnPublication({
    plan: { ok: true, inheritParentModel: true },
  });
  assert.deepEqual(publication, { kind: "inherit" });
});
