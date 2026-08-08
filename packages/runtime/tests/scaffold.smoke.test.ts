import assert from "node:assert/strict";
import { test } from "node:test";
import { getChildPool } from "@xzy-ai/runtime";
import { MAX_CONCURRENCY, MAX_PARALLEL_AGENTS } from "@xzy-ai/core";

/**
 * Phase 1 smoke tests.
 *
 * These exercise the plan's acceptance criteria that are verifiable without a
 * live PI host: the package compiles, the shared per-project pool keyed by
 * project root is a stable singleton, and the reference constants are exported.
 * The full acceptance gate (extension factory discovery, four registered tools,
 * structured boundary responses) is verified by the live `pi -e` run.
 */

test("constants match the reference values", () => {
  assert.equal(MAX_CONCURRENCY, 2);
  assert.equal(MAX_PARALLEL_AGENTS, 3);
});

test("child pool is a stable singleton keyed by project root", () => {
  const a = getChildPool("/tmp/projects/a");
  const b = getChildPool("/tmp/projects/a");
  const c = getChildPool("/tmp/projects/b");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.projectRoot, "/tmp/projects/a");
  assert.ok(a.registry.all() instanceof Map);
});

test("child pool slot is namespaced by project root", () => {
  const a = getChildPool("/tmp/projects/ns-a");
  const c = getChildPool("/tmp/projects/ns-b");
  a.registry.all().set("j1", undefined as never);
  assert.ok(!c.registry.all().has("j1"));
});

test("publishing a live child notifies live-activity subscribers", () => {
  const pool = getChildPool("/tmp/projects/activity");
  let notified = 0;
  const unsubscribe = pool.liveActivity.subscribe(() => {
    notified++;
  });

  pool.liveChildren.set("job-a", {
    live: {
      snapshot: { status: "running", settled: false, transcript: [] },
      subscribe: () => () => {},
      steer: async () => {},
      abort: async () => {},
    },
  });

  assert.ok(notified >= 1, "publishing a live child notifies activity subscribers");
  unsubscribe();
});