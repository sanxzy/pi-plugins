import assert from "node:assert/strict";
import { test } from "node:test";
import { getChildPool } from "@xzy-ai/runtime";
import { MAX_CONCURRENCY, MAX_PARALLEL_AGENTS, createJob } from "@xzy-ai/core";

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

test("getChildPool upgrades a stale singleton left by an older extension runtime", () => {
  const root = "/tmp/projects/reload-upgrade";
  const first = getChildPool(root, "root-a");
  const stored = globalThis.piC2Pool?.[`pi-c2:${root}`];
  assert.ok(stored);
  // Simulate the pool created by a previous extension runtime (pre-merge):
  // the singleton keeps its durable registry, live children, and gate, but
  // the newer per-session delivery surface is missing from the object.
  delete (stored as { deliveryFor?: unknown }).deliveryFor;
  delete (stored as { rootSessionIdFor?: unknown }).rootSessionIdFor;
  const marker = { sessionFile: undefined };
  stored.liveChildren.set("still-running", marker as never);
  const upgraded = getChildPool(root, "root-a");
  assert.equal(upgraded, first, "the singleton identity survives the upgrade");
  assert.equal(typeof upgraded.deliveryFor, "function");
  assert.equal(typeof upgraded.rootSessionIdFor, "function");
  assert.equal(upgraded.liveChildren.get("still-running"), marker, "live child handles survive");
  const coordinator = upgraded.deliveryFor("root-a");
  assert.equal(coordinator, upgraded.deliveryFor("root-a"), "one coordinator per root session");
});

test("getChildPool replaces a stale registry that cannot refresh", () => {
  const root = "/tmp/projects/reload-registry-upgrade";
  // Seed a real job on disk through the current runtime.
  const seed = getChildPool(root, "root-a");
  seed.registry.createJob(createJob({
    jobId: "on-disk-job",
    parentSessionId: "root-a",
    status: "queued",
    description: "on-disk-job",
    subagentType: "test-agent",
  }));
  // Simulate a pool built by an older runtime whose registry cannot refresh
  // and therefore holds a stale in-memory view of home storage.
  const stale: Record<string, unknown> = {
    projectRoot: root,
    registry: {
      get: () => undefined,
      all: () => new Map(),
      getBySessionId: () => undefined,
      createJob() {},
      updateJob() {},
      ensureSession() {},
      // deliberately absent: no refresh()/load-on-read from older modules
    },
    scopedRegistry: undefined,
    rootSessionId: "root-a",
    concurrency: seed.concurrency,
    liveChildren: new Map(),
    resetParallelAgents() {},
  };
  globalThis.piC2Pool[`pi-c2:${root}`] = stale as never;
  const upgraded = getChildPool(root, "root-a");
  assert.equal(upgraded, stale, "the singleton identity survives the upgrade");
  const registry = upgraded.registry as unknown as { refresh?: unknown; all: () => Map<string, unknown> };
  assert.equal(typeof registry?.refresh, "function", "registry is replaced with a refreshing one");
  assert.ok(registry.all().has("on-disk-job"), "replaced registry reads the authoritative on-disk job");
});
