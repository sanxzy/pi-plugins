import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createReferenceCatalogWithInfrastructure } from "../src/infrastructure/references/catalog.ts";

function root(): string {
  return mkdtempSync(join(tmpdir(), "pi-c2-setup-contract-"));
}

function local(
  rootDir: string,
  doc: unknown,
): ReturnType<typeof createReferenceCatalogWithInfrastructure> {
  const catalog = createReferenceCatalogWithInfrastructure({ agentDir: join(rootDir, "agent"), homeDir: rootDir });
  mkdirSync(dirname(catalog.filePath), { recursive: true });
  writeFileSync(catalog.filePath, JSON.stringify(doc), "utf8");
  return catalog;
}

test("raw-document read returns the persisted strict-JSON shape without resolution or materialization", async () => {
  const rootDir = root();
  const docs = join(rootDir, "docs");
  mkdirSync(docs, { recursive: true });
  const doc = { references: { local: { path: docs, description: "", hidden: true }, git: "owner/repo" } };
  local(rootDir, doc);
  let materialized = 0;
  const materializer = {
    preflight: async () => {
      materialized += 1;
      return { ok: true as const };
    },
    ensure: async () => {
      materialized += 1;
      throw new Error("must not materialize");
    },
  };
  const catalog2 = createReferenceCatalogWithInfrastructure({
    agentDir: join(rootDir, "agent"),
    homeDir: rootDir,
    materializer,
  });
  const result = await catalog2.readDocument();
  assert.deepEqual(result, doc);
  assert.equal(materialized, 0);
});

test("setup preflight rejects a missing local root and preserves previous document on failed save", async () => {
  const rootDir = root();
  const docs = join(rootDir, "docs");
  mkdirSync(docs, { recursive: true });
  const catalog = createReferenceCatalogWithInfrastructure({
    agentDir: join(rootDir, "agent"),
    homeDir: rootDir,
    materializer: {
      preflight: async () => ({ ok: true as const }),
      ensure: async () => {
        throw new Error("no materialization during setup");
      },
    },
  });
  const result = await catalog.save({ references: { docs } });
  assert.deepEqual(result, { ok: true });
  const result2 = await catalog.save({ references: { docs, missing: join(rootDir, "missing") } });
  assert.equal(result2.ok, false);
  assert.deepEqual(await catalog.readDocument(), { references: { docs } });
});

test("setup preflight resolves a branchless Git default branch before save", async () => {
  const rootDir = root();
  const catalog = createReferenceCatalogWithInfrastructure({
    agentDir: join(rootDir, "agent"),
    homeDir: rootDir,
    materializer: {
      preflight: async ({ reference, branch }) => {
        if (reference.remote.includes("unreachable")) return { ok: false, error: "Repository is unavailable" };
        if (branch === undefined) {
          // Branchless remote: a usable default is required.
          return { ok: false, error: "Default branch is required" };
        }
        return buildPreflight(reference, branch);
      },
      ensure: async () => {
        throw new Error("no materialization during setup preflight");
      },
    },
  });
  const result = await catalog.save({ references: { unfinished: { repository: "facebook/react" } } });
  assert.equal(result.ok, false);
  assert.equal(result.error, "Git reference preflight failed");
});

function buildPreflight(reference: { remote: string; label: string }, branch: string) {
  void reference;
  void branch;
  return { ok: true as const };
}

test("per-entry Test and Refresh are observational and do not change the saved document", async () => {  const rootDir = root();
  const catalog = createReferenceCatalogWithInfrastructure({
    agentDir: join(rootDir, "agent"),
    homeDir: rootDir,
    materializer: {
      preflight: async () => ({ ok: true }),
      ensure: async ({ refresh }) =>
        refresh
          ? { localPath: join(rootDir, "repos", "repo"), status: "refreshed" as const, head: "abcd", branch: "main" }
          : { localPath: join(rootDir, "repos", "repo"), status: "cloned" as const },
    },
  });
  const testResult = await catalog.testReference({ repository: "owner/repo", branch: "main" });
  assert.equal(testResult.ok, true);
  const refreshResult = await catalog.refreshReference({ repository: "owner/repo", branch: "main" });
  assert.equal(refreshResult.ok, true);
  const after = await catalog.readDocument();
  assert.deepEqual(after, { references: {} });
});

test("save is abort-aware and does not publish after the signal aborts", async () => {
  const rootDir = root();
  const catalog = createReferenceCatalogWithInfrastructure({
    agentDir: join(rootDir, "agent"),
    homeDir: rootDir,
    materializer: {
      preflight: async (_input: unknown, signal?: AbortSignal) => {
        if (signal?.aborted) return { ok: false, error: "Git materialization aborted" };
        return { ok: true };
      },
      ensure: async () => {
        throw new Error("no materialization");
      },
    },
  });
  const controller = new AbortController();
  controller.abort();
  const result = await catalog.save({ references: { docs: rootDir } }, { signal: controller.signal });
  assert.deepEqual(result, { ok: false, error: "Git materialization aborted" });
  assert.throws(() => readFileSync(catalog.filePath, "utf8"), /ENOENT/);
});
