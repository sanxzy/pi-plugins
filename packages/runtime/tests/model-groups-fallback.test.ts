import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function tempHome(): string { return mkdtempSync(join(tmpdir(), "pi-c2-fallback-")); }
function withHome(home: string, run: () => void): void {
  const prev = process.env.PI_C2_TEST_HOME;
  process.env.PI_C2_TEST_HOME = home; process.env.PI_C2_HOME = home;
  try { run(); } finally { if (prev === undefined) { delete process.env.PI_C2_TEST_HOME; delete process.env.PI_C2_HOME; } else { process.env.PI_C2_TEST_HOME = prev; process.env.PI_C2_HOME = prev; } }
}

test("fallback quarantines 4xx and retries next model in same turn", async () => {
  const { saveModelGroups, clearModelGroupsCache, clearRoundRobinPointers } = await import("../src/infrastructure/model-groups/store.ts");
  const { clearQuarantine, isQuarantined } = await import("../src/infrastructure/model-groups/quarantine.ts");
  const { runWithModelGroupFallback } = await import("../src/infrastructure/model-groups/fallback.ts");
  const home = tempHome();
  try {
    withHome(home, () => {
      clearModelGroupsCache(); clearQuarantine(); clearRoundRobinPointers();
      saveModelGroups({ groups: [{ id: "g1", name: "Work", mode: "fallback", quarantineMinutes: 5, models: [{ ref: "openai/a" }, { ref: "openai/b" }] }], activeGroupId: "g1" });
      let call = 0;
      const result = runWithModelGroupFallback({
        attempt: (ref) => {
          call++;
          if (ref === "openai/a") return { ok: false, status: 429, error: "rate limit" };
          return { ok: true, value: "success-b" };
        },
        now: Date.now(),
      });
      assert.equal(result.ok, true);
      assert.equal((result as any).value, "success-b");
      assert.equal((result as any).usedRef, "openai/b");
      assert.equal(isQuarantined("openai/a"), true);
      assert.equal(call, 2);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("all quarantined fails with nextRetryAt", async () => {
  const { saveModelGroups, clearModelGroupsCache } = await import("../src/infrastructure/model-groups/store.ts");
  const { clearQuarantine, quarantineModel } = await import("../src/infrastructure/model-groups/quarantine.ts");
  const { runWithModelGroupFallback } = await import("../src/infrastructure/model-groups/fallback.ts");
  const home = tempHome();
  try {
    withHome(home, () => {
      clearModelGroupsCache(); clearQuarantine();
      saveModelGroups({ groups: [{ id: "g1", name: "Work", mode: "fallback", quarantineMinutes: 5, models: [{ ref: "openai/a" }, { ref: "openai/b" }] }], activeGroupId: "g1" });
      quarantineModel("openai/a", 5);
      quarantineModel("openai/b", 5);
      const result = runWithModelGroupFallback({
        attempt: (ref) => ({ ok: false, status: 500, error: `fail ${ref}` }),
        now: Date.now(),
      });
      assert.equal(result.ok, false);
      assert.ok((result as any).nextRetryAt !== undefined);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("round-robin advances per turn and skips quarantined", async () => {
  const { saveModelGroups, clearModelGroupsCache, clearRoundRobinPointers } = await import("../src/infrastructure/model-groups/store.ts");
  const { clearQuarantine, quarantineModel } = await import("../src/infrastructure/model-groups/quarantine.ts");
  const { runWithModelGroupFallback } = await import("../src/infrastructure/model-groups/fallback.ts");
  const home = tempHome();
  try {
    withHome(home, () => {
      clearModelGroupsCache(); clearQuarantine(); clearRoundRobinPointers();
      saveModelGroups({ groups: [{ id: "g1", name: "RR", mode: "round-robin", quarantineMinutes: 5, models: [{ ref: "openai/a" }, { ref: "openai/b" }, { ref: "openai/c" }] }], activeGroupId: "g1" });
      const r1 = runWithModelGroupFallback({ attempt: (ref) => ({ ok: true, value: ref }), now: Date.now() });
      assert.equal((r1 as any).usedRef, "openai/a");
      const r2 = runWithModelGroupFallback({ attempt: (ref) => ({ ok: true, value: ref }), now: Date.now() });
      assert.equal((r2 as any).usedRef, "openai/b");
      quarantineModel("openai/c", 5);
      const r3 = runWithModelGroupFallback({ attempt: (ref) => ({ ok: true, value: ref }), now: Date.now() });
      // Should skip c, go to a
      assert.equal((r3 as any).usedRef, "openai/a");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
