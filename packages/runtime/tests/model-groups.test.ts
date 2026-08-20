import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function tempHome(): string { return mkdtempSync(join(tmpdir(), "pi-c2-model-groups-")); }
function withHome(home: string, run: () => void): void {
  const prev = process.env.PI_C2_TEST_HOME;
  process.env.PI_C2_TEST_HOME = home;
  process.env.PI_C2_HOME = home;
  try { run(); } finally {
    if (prev === undefined) { delete process.env.PI_C2_TEST_HOME; delete process.env.PI_C2_HOME; }
    else { process.env.PI_C2_TEST_HOME = prev; process.env.PI_C2_HOME = prev; }
  }
}

test("model-groups.json is created with 0600 and fingerprint cache handles external edits", async () => {
  const { homeModelGroupsFile, getModelGroups, saveModelGroups, clearModelGroupsCache } = await import("../src/infrastructure/model-groups/store.ts");
  const home = tempHome();
  try {
    withHome(home, () => {
      clearModelGroupsCache();
      const file = homeModelGroupsFile();
      assert.equal(existsSync(file), false);
      const res = saveModelGroups({ groups: [{ id: "g1", name: "Work", mode: "fallback", quarantineMinutes: 5, models: [{ ref: "openai/gpt-4o", thinking: "off" }] }], activeGroupId: "g1" });
      assert.equal(res.ok, true);
      assert.equal(existsSync(file), true);
      const mode = statSync(file).mode & 0o777;
      assert.equal(mode, 0o600);
      const first = getModelGroups();
      assert.equal(first.groups.length, 1);
      writeFileSync(file, JSON.stringify({ groups: [], activeGroupId: undefined }));
      const second = getModelGroups();
      assert.equal(second.groups.length, 0);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("malformed JSON degrades to empty groups", async () => {
  const { homeModelGroupsFile, getModelGroups, clearModelGroupsCache } = await import("../src/infrastructure/model-groups/store.ts");
  const home = tempHome();
  try {
    withHome(home, () => {
      clearModelGroupsCache();
      const file = homeModelGroupsFile();
      mkdirSync(join(home, "pi-c2"), { recursive: true });
      writeFileSync(file, "not json");
      const groups = getModelGroups();
      assert.equal(groups.groups.length, 0);
      assert.equal(groups.activeGroupId, undefined);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("validation rejects invalid fields", async () => {
  const { saveModelGroups, clearModelGroupsCache } = await import("../src/infrastructure/model-groups/store.ts");
  const home = tempHome();
  try {
    withHome(home, () => {
      clearModelGroupsCache();
      const resEmpty = saveModelGroups({ groups: [{ id: "g1", name: "", mode: "fallback", quarantineMinutes: 5, models: [] }], activeGroupId: "g1" });
      assert.equal(resEmpty.ok, false);
      const resBadMode = saveModelGroups({ groups: [{ id: "g1", name: "A", mode: "invalid" as any, quarantineMinutes: 5, models: [{ ref: "openai/gpt-4o" }] }], activeGroupId: undefined });
      assert.equal(resBadMode.ok, false);
      const resBadQuarantine = saveModelGroups({ groups: [{ id: "g1", name: "A", mode: "fallback", quarantineMinutes: 0, models: [{ ref: "openai/gpt-4o" }] }], activeGroupId: undefined });
      assert.equal(resBadQuarantine.ok, false);
      const resBadRef = saveModelGroups({ groups: [{ id: "g1", name: "A", mode: "fallback", quarantineMinutes: 5, models: [{ ref: "bad-ref" }] }], activeGroupId: undefined });
      assert.equal(resBadRef.ok, false);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("activeGroupId resolves to non-quarantined model per mode", async () => {
  const { saveModelGroups, resolveActiveModel, clearModelGroupsCache } = await import("../src/infrastructure/model-groups/store.ts");
  const { quarantineModel, clearQuarantine } = await import("../src/infrastructure/model-groups/quarantine.ts");
  const home = tempHome();
  try {
    withHome(home, () => {
      clearModelGroupsCache(); clearQuarantine();
      saveModelGroups({ groups: [{ id: "g1", name: "Work", mode: "fallback", quarantineMinutes: 5, models: [{ ref: "openai/gpt-4o" }, { ref: "openai/gpt-4o-mini" }] }], activeGroupId: "g1" });
      const first = resolveActiveModel();
      assert.equal(first?.ref, "openai/gpt-4o");
      quarantineModel("openai/gpt-4o", 5);
      const second = resolveActiveModel();
      assert.equal(second?.ref, "openai/gpt-4o-mini");
      clearQuarantine();
      const third = resolveActiveModel();
      assert.equal(third?.ref, "openai/gpt-4o");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("deleting active group clears active pointer", async () => {
  const { saveModelGroups, getModelGroups, clearModelGroupsCache } = await import("../src/infrastructure/model-groups/store.ts");
  const home = tempHome();
  try {
    withHome(home, () => {
      clearModelGroupsCache();
      saveModelGroups({ groups: [{ id: "g1", name: "A", mode: "fallback", quarantineMinutes: 5, models: [{ ref: "openai/gpt-4o" }] }], activeGroupId: "g1" });
      const saved = saveModelGroups({ groups: [], activeGroupId: "g1" });
      assert.equal(saved.ok, true);
      const after = getModelGroups();
      assert.equal(after.activeGroupId, undefined);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("derived contextWindow is min of members", async () => {
  const { deriveGroupContextWindow } = await import("../src/infrastructure/model-groups/store.ts");
  const group = { id: "g1", name: "A", mode: "fallback" as const, quarantineMinutes: 5, models: [{ ref: "openai/gpt-4o" }, { ref: "openai/gpt-4o-mini" }] };
  const catalog = [{ provider: "openai", id: "gpt-4o", contextWindow: 128000 }, { provider: "openai", id: "gpt-4o-mini", contextWindow: 64000 }];
  const cw = deriveGroupContextWindow(group, catalog);
  assert.equal(cw, 64000);
});

test("round-robin rotates and skips quarantined", async () => {
  const { saveModelGroups, resolveActiveModel, clearModelGroupsCache, clearRoundRobinPointers } = await import("../src/infrastructure/model-groups/store.ts");
  const { quarantineModel, clearQuarantine } = await import("../src/infrastructure/model-groups/quarantine.ts");
  const home = tempHome();
  try {
    withHome(home, () => {
      clearModelGroupsCache(); clearQuarantine(); clearRoundRobinPointers();
      saveModelGroups({ groups: [{ id: "g1", name: "Work", mode: "round-robin", quarantineMinutes: 5, models: [{ ref: "openai/a" }, { ref: "openai/b" }, { ref: "openai/c" }] }], activeGroupId: "g1" });
      assert.equal(resolveActiveModel()?.ref, "openai/a");
      assert.equal(resolveActiveModel()?.ref, "openai/b");
      assert.equal(resolveActiveModel()?.ref, "openai/c");
      assert.equal(resolveActiveModel()?.ref, "openai/a");
      quarantineModel("openai/b", 5);
      // Next should skip b
      assert.equal(resolveActiveModel()?.ref, "openai/c");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
