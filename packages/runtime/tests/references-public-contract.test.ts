import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import * as runtime from "@xzy-ai/runtime";
import type { ReferenceCatalogEntry, ReferenceMaterializationStatus } from "@xzy-ai/runtime";

function root(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-public-references-"));
}

test("publishes a stable mixed local and degraded catalog through the runtime boundary", async () => {
  const rootDir = root();
  const agentDir = join(rootDir, "agent");
  const docs = join(rootDir, "docs");
  mkdirSync(docs, { recursive: true });
  const catalog = runtime.createReferenceCatalog({ agentDir, homeDir: rootDir });
  mkdirSync(dirname(catalog.filePath), { recursive: true });
  writeFileSync(
    catalog.filePath,
    JSON.stringify({
      references: {
        good: { path: docs, description: "Local docs", hidden: true },
        missing: join(rootDir, "missing"),
        malformedGit: { repository: "owner/repo", branch: null },
      },
    }),
    "utf8",
  );

  const result = await catalog.read();
  assert.deepEqual(result.entries.map(({ name }) => name), ["good", "malformedGit", "missing"]);
  const byName = new Map(result.entries.map((entry) => [entry.name, entry]));
  const good = byName.get("good")!;
  const malformedGit = byName.get("malformedGit")!;
  assert.equal(good.status, "available");
  assert.deepEqual(good.source, { type: "local", path: docs, description: "Local docs", hidden: true });
  assert.equal(good.path, realpathSync(docs));
  assert.equal(malformedGit.status, "unavailable");
  assert.equal(malformedGit.path, undefined);
  assert.equal(malformedGit.diagnostic, "Git reference is invalid");
  assert.equal(byName.get("missing")!.status, "unavailable");
  assert.deepEqual(result.diagnostics, [
    "Reference 'malformedGit' is unavailable",
    "Reference 'missing' has an unavailable local path",
  ]);
  assert.equal(existsSync(join(agentDir, "pi-code", "wikis")), false);
});

test("keeps the public catalog fresh without exposing infrastructure details", async () => {
  const rootDir = root();
  const catalog = runtime.createReferenceCatalog({ agentDir: join(rootDir, "agent"), homeDir: rootDir });
  await catalog.save({ references: { first: rootDir } });
  assert.deepEqual((await catalog.read()).entries.map(({ name }) => name), ["first"]);
  writeFileSync(catalog.filePath, JSON.stringify({ references: { second: rootDir } }), "utf8");
  assert.deepEqual((await catalog.read()).entries.map(({ name }) => name), ["second"]);

  assert.equal("createGitMaterializer" in runtime, false);
  assert.equal("referenceReposDir" in runtime, false);
  assert.equal("referenceConfigFile" in runtime, false);
  assert.equal("run" in catalog, false);
  assert.equal("fileSystem" in catalog, false);
  assert.equal("reposDir" in catalog, false);
});

function acceptsPublicEntry(entry: ReferenceCatalogEntry): string {
  return `${entry.name}:${entry.status}`;
}

const materializationStatus: ReferenceMaterializationStatus = "cached";
assert.equal(materializationStatus, "cached");
assert.equal(acceptsPublicEntry({ name: "docs", source: { type: "local", path: "/tmp/docs" }, status: "available" }), "docs:available");
