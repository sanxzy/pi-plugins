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

test("group contextWindow is persisted and caps the derived member window", async () => {
  const { saveModelGroups, getModelGroups, deriveGroupContextWindow, clearModelGroupsCache } = await import("../src/infrastructure/model-groups/store.ts");
  const home = tempHome();
  try {
    withHome(home, () => {
      clearModelGroupsCache();
      const saved = saveModelGroups({
        groups: [{
          id: "g1",
          name: "A",
          mode: "fallback",
          quarantineMinutes: 5,
          contextWindow: 32000,
          models: [{ ref: "openai/gpt-4o" }, { ref: "openai/gpt-4o-mini" }],
        }],
        activeGroupId: "g1",
      } as any);
      assert.equal(saved.ok, true);
      const group = getModelGroups().groups[0]! as any;
      assert.equal(group.contextWindow, 32000);
      const catalog = [{ provider: "openai", id: "gpt-4o", contextWindow: 128000 }, { provider: "openai", id: "gpt-4o-mini", contextWindow: 64000 }];
      assert.equal(deriveGroupContextWindow(group, catalog), 32000);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("host bridge lists and activates groups with the configured context cap", async () => {
  const { saveModelGroups, installModelGroupHostApi, clearModelGroupsCache, _test } = await import("../src/infrastructure/model-groups/store.ts");
  const home = tempHome();
  try {
    withHome(home, () => {
      clearModelGroupsCache();
      saveModelGroups({
        groups: [{
          id: "helper-models",
          name: "helper-models",
          mode: "round-robin",
          quarantineMinutes: 5,
          contextWindow: 32000,
          models: [{ ref: "openai/gpt-a", thinking: "high" }, { ref: "openai/gpt-b" }],
        }],
      });
      installModelGroupHostApi();
      const api = (globalThis as typeof globalThis & { [key: symbol]: unknown })[Symbol.for(_test.MODEL_GROUP_HOST_API_KEY)] as {
        list: () => readonly { id: string; contextWindow?: number; active: boolean }[];
        activate: (id: string) => { ok: boolean; modelRef?: string; contextWindow?: number };
        clearActiveGroup: () => void;
      };
      assert.deepEqual(api.list(), [{ id: "helper-models", name: "helper-models", mode: "round-robin", modelRefs: ["openai/gpt-a", "openai/gpt-b"], contextWindow: 32000, active: false }]);
      const activated = api.activate("helper-models");
      assert.deepEqual(activated, { ok: true, groupId: "helper-models", groupName: "helper-models", modelRef: "openai/gpt-a", thinking: "high", contextWindow: 32000 });
      assert.equal(api.list()[0]!.active, true);
      api.clearActiveGroup();
      assert.equal(api.list()[0]!.active, false);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
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

test("derived contextWindow resolves ids that contain slashes", async () => {
  const { deriveGroupContextWindow } = await import("../src/infrastructure/model-groups/store.ts");
  const group = { id: "g1", name: "A", mode: "fallback" as const, quarantineMinutes: 5, models: [{ ref: "openrouter/stealth/ox-alpha" }] };
  const catalog = [{ provider: "openrouter", id: "stealth/ox-alpha", contextWindow: 200000 }];
  assert.equal(deriveGroupContextWindow(group, catalog), 200000);
});

test("model group persistence accepts provider-scoped slashed ids", async () => {
  const { saveModelGroups, getModelGroups, clearModelGroupsCache } = await import("../src/infrastructure/model-groups/store.ts");
  const home = tempHome();
  try {
    withHome(home, () => {
      clearModelGroupsCache();
      const saved = saveModelGroups({ groups: [{ id: "g1", name: "A", mode: "round-robin", quarantineMinutes: 5, models: [{ ref: "openrouter/stealth/ox-alpha" }] }] });
      assert.equal(saved.ok, true);
      assert.equal(getModelGroups().groups[0]!.models[0]!.ref, "openrouter/stealth/ox-alpha");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("host api resolveActive rotates round-robin members per call in configured order", async () => {
  const { installModelGroupHostApi, saveModelGroups, clearModelGroupsCache, clearRoundRobinPointers, clearActiveGroup } = await import("../src/infrastructure/model-groups/store.ts");
  const { clearQuarantine, quarantineModel } = await import("../src/infrastructure/model-groups/quarantine.ts");
  const home = tempHome();
  try {
    withHome(home, () => {
      clearModelGroupsCache();
      clearRoundRobinPointers();
      clearQuarantine();
      installModelGroupHostApi();
      const api = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-c2.model-groups")] as {
        activate(id: string): { ok: boolean; error?: string };
        resolveActive?(): { ref: string; thinking?: string; contextWindow?: number } | undefined;
      };
      assert.equal(typeof api.resolveActive, "function", "host api must expose resolveActive");
      const saved = saveModelGroups({
        groups: [{ id: "g1", name: "A", mode: "round-robin", quarantineMinutes: 5, models: [{ ref: "openai/gpt-a" }, { ref: "openai/gpt-b" }, { ref: "openai/gpt-c" }] }],
      });
      assert.equal(saved.ok, true);
      assert.equal(api.activate("g1").ok, true);
      const refs = [api.resolveActive!(), api.resolveActive!(), api.resolveActive!(), api.resolveActive!()].map((entry) => entry?.ref);
      assert.deepEqual(refs, ["openai/gpt-a", "openai/gpt-b", "openai/gpt-c", "openai/gpt-a"]);
      // Quarantined members are skipped without stalling the rotation.
      quarantineModel("openai/gpt-b", 5);
      const next = [api.resolveActive!(), api.resolveActive!()].map((entry) => entry?.ref);
      assert.deepEqual(next, ["openai/gpt-c", "openai/gpt-a"]);
      // No active group resolves to undefined.
      clearActiveGroup();
      assert.equal(api.resolveActive!(), undefined);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("reportFailure quarantines the failed member and returns the next available model", async () => {
  const { installModelGroupHostApi, saveModelGroups, clearModelGroupsCache, clearRoundRobinPointers, clearActiveGroup } = await import("../src/infrastructure/model-groups/store.ts");
  const { clearQuarantine, quarantineModel: _q, getQuarantineMap } = await import("../src/infrastructure/model-groups/quarantine.ts");
  const home = tempHome();
  try {
    withHome(home, () => {
      clearModelGroupsCache();
      clearRoundRobinPointers();
      clearQuarantine();
      installModelGroupHostApi();
      const api = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-c2.model-groups")] as {
        activate(id: string): { ok: boolean };
        reportFailure?(failedRef: string): { ref: string } | undefined;
      };
      assert.equal(typeof api.reportFailure, "function", "host api must expose reportFailure");

      // Round-robin: failing member is quarantined and the next member is returned.
      saveModelGroups({ groups: [{ id: "g1", name: "A", mode: "round-robin", quarantineMinutes: 5, models: [{ ref: "openai/gpt-a" }, { ref: "openai/gpt-b" }, { ref: "openai/gpt-c" }] }] });
      assert.equal(api.activate("g1").ok, true);
      const next = api.reportFailure!("openai/gpt-a");
      assert.equal(next?.ref, "openai/gpt-b");
      assert.ok(getQuarantineMap().has("openai/gpt-a"), "failed member must be quarantined");

      // Fallback: failures walk the configured order and exhaust deterministically.
      saveModelGroups({ groups: [{ id: "g2", name: "B", mode: "fallback", quarantineMinutes: 5, models: [{ ref: "openai/gpt-a" }, { ref: "openai/gpt-b" }, { ref: "openai/gpt-c" }] }], activeGroupId: "g2" });
      clearQuarantine();
      assert.equal(api.reportFailure!("openai/gpt-a")?.ref, "openai/gpt-b");
      assert.equal(api.reportFailure!("openai/gpt-b")?.ref, "openai/gpt-c");
      assert.equal(api.reportFailure!("openai/gpt-c"), undefined);

      // Non-members are ignored entirely.
      clearQuarantine();
      assert.equal(api.reportFailure!("other/model"), undefined);
      assert.equal(getQuarantineMap().has("other/model"), false);

      // No active group: undefined.
      clearActiveGroup();
      assert.equal(api.reportFailure!("openai/gpt-a"), undefined);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
