import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function tempHome(): string { return mkdtempSync(join(tmpdir(), "pi-c2-group-binding-")); }
function withHome(home: string, run: () => void): void {
  const prev = process.env.PI_C2_TEST_HOME;
  process.env.PI_C2_TEST_HOME = home;
  process.env.PI_C2_HOME = home;
  try { run(); } finally {
    if (prev === undefined) { delete process.env.PI_C2_TEST_HOME; delete process.env.PI_C2_HOME; }
    else { process.env.PI_C2_TEST_HOME = prev; process.env.PI_C2_HOME = prev; }
  }
}

async function store() {
  return import("../src/infrastructure/model-groups/store.ts");
}
async function quarantine() {
  return import("../src/infrastructure/model-groups/quarantine.ts");
}

const GROUPS = {
  groups: [
    {
      id: "alpha",
      name: "Alpha",
      mode: "round-robin" as const,
      quarantineTurns: 2,
      models: [
        { ref: "prov/one", thinking: "high" },
        { ref: "prov/two" },
        { ref: "prov/three" },
      ],
    },
    {
      id: "beta",
      name: "Beta",
      mode: "fallback" as const,
      quarantineTurns: 3,
      models: [{ ref: "other/one" }, { ref: "other/two" }],
    },
  ],
  activeGroupId: "alpha",
};

test("getGroupById returns a validated copy of the named group only", async (t) => {
  const home = tempHome();
  try {
    const { saveModelGroups, getGroupById, clearModelGroupsCache, clearRoundRobinPointers } = await store();
    const q = await quarantine();
    t.after(() => q.clearQuarantine());
    withHome(home, () => {
      clearModelGroupsCache();
      clearRoundRobinPointers();
      assert.equal(saveModelGroups(GROUPS).ok, true);
      const alpha = getGroupById("alpha");
      assert.ok(alpha);
      assert.equal(alpha.id, "alpha");
      assert.equal(alpha.models.length, 3);
      assert.equal(getGroupById("nope"), undefined);
      assert.equal(getGroupById(""), undefined);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("resolveGroupModel round-robins within the named group and never touches the active group", async (t) => {
  const home = tempHome();
  try {
    const s = await store();
    const q = await quarantine();
    t.after(() => q.clearQuarantine());
    withHome(home, () => {
      s.clearModelGroupsCache();
      s.clearRoundRobinPointers();
      assert.equal(s.saveModelGroups(GROUPS).ok, true);
      // Rotating inside beta must not disturb the active group alpha.
      const first = s.resolveGroupModel("beta");
      assert.equal(first?.ref, "other/one");
      const second = s.resolveGroupModel("beta");
      assert.equal(second?.ref, "other/one", "fallback mode stays on the first available member");
      const a1 = s.resolveGroupModel("alpha");
      const a2 = s.resolveGroupModel("alpha");
      const a3 = s.resolveGroupModel("alpha");
      assert.deepEqual([a1?.ref, a2?.ref, a3?.ref], ["prov/one", "prov/two", "prov/three"]);
      assert.equal(s.resolveGroupModel("missing"), undefined);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("resolveGroupModel skips quarantined members of the named group", async (t) => {
  const home = tempHome();
  try {
    const s = await store();
    const q = await quarantine();
    t.after(() => q.clearQuarantine());
    withHome(home, () => {
      s.clearModelGroupsCache();
      s.clearRoundRobinPointers();
      assert.equal(s.saveModelGroups(GROUPS).ok, true);
      q.quarantineModel("prov/one", 5);
      const first = s.resolveGroupModel("alpha");
      assert.equal(first?.ref, "prov/two", "quarantined prov/one is skipped without advancing past it");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("resolveGroupModel returns undefined when every member of the named group is quarantined", async (t) => {
  const home = tempHome();
  try {
    const s = await store();
    const q = await quarantine();
    t.after(() => q.clearQuarantine());
    withHome(home, () => {
      s.clearModelGroupsCache();
      s.clearRoundRobinPointers();
      assert.equal(s.saveModelGroups({ groups: [GROUPS.groups[1]!], activeGroupId: undefined }).ok, true);
      q.quarantineModel("other/one", 5);
      q.quarantineModel("other/two", 5);
      assert.equal(s.resolveGroupModel("beta"), undefined);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("reportGroupFailure quarantines a member of the named group and returns the next one", async (t) => {
  const home = tempHome();
  try {
    const s = await store();
    const q = await quarantine();
    t.after(() => q.clearQuarantine());
    withHome(home, () => {
      s.clearModelGroupsCache();
      s.clearRoundRobinPointers();
      assert.equal(s.saveModelGroups(GROUPS).ok, true);
      const next = s.reportGroupFailure("alpha", "prov/one");
      assert.equal(next?.ref, "prov/two");
      assert.ok(q.isQuarantined("prov/one"));
      // A non-member failure is ignored and yields no replacement.
      assert.equal(s.reportGroupFailure("alpha", "elsewhere/none"), undefined);
      assert.equal(s.reportGroupFailure("missing", "prov/one"), undefined);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the host api accepts an explicit group id and keeps the active group untouched", async (t) => {
  const home = tempHome();
  try {
    const s = await store();
    const q = await quarantine();
    t.after(() => q.clearQuarantine());
    withHome(home, () => {
      s.clearModelGroupsCache();
      s.clearRoundRobinPointers();
      assert.equal(s.saveModelGroups(GROUPS).ok, true);
      const api = s.buildModelGroupHostApi();
      // Active group resolution still works with no arguments.
      assert.equal(api.resolveActive()?.ref, "prov/one");
      // Explicit ids resolve independently of the active selection.
      assert.equal(api.resolveActive("beta")?.ref, "other/one");
      assert.equal(api.resolveActive("missing"), undefined);
      assert.equal(api.reportFailure("other/one", "beta")?.ref, "other/two");
      assert.ok(q.isQuarantined("other/one"));
      // The default failure path still targets the ACTIVE group only.
      assert.equal(api.reportFailure("other/two"), undefined, "non-member of the active group is ignored");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
