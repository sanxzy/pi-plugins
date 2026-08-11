import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createReferenceCatalogWithInfrastructure } from "../src/infrastructure/references/catalog.ts";
import { referenceConfigFile } from "../src/infrastructure/references/catalog.ts";
import { createGitMaterializer as createInternalGitMaterializer } from "../src/infrastructure/references/git-materializer.ts";

/** Materializer that never reaches the network; Git entries stay unavailable. */
function offlineMaterializer() {
  return createInternalGitMaterializer({
    run: async (args) => {
      if (args[1] === "ls-remote") return { stdout: "hash refs/heads/main\n", stderr: "" };
      throw new Error("offline test materializer");
    },
  });
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-references-"));
}

function withAgentDir<T>(agentDir: string, run: () => T): T {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

test("derives the global references file below the active Pi agent directory", () => {
  const agentDir = join(tempRoot(), "agent");
  withAgentDir(agentDir, () => {
    assert.equal(referenceConfigFile(), join(agentDir, "pi-code", "references.json"));
  });
});

test("missing configuration is an empty catalog and reads are on demand", async () => {
  const root = tempRoot();
  const catalog = createReferenceCatalogWithInfrastructure({ agentDir: join(root, "agent"), homeDir: join(root, "home") });
  assert.deepEqual(await catalog.read(), { entries: [], diagnostics: [] });

  mkdirSync(dirname(catalog.filePath), { recursive: true });
  writeFileSync(catalog.filePath, JSON.stringify({ references: { docs: "/tmp/docs" } }), "utf8");
  const reread = await catalog.read();
  assert.equal(reread.entries.length, 1);
  assert.equal(reread.entries[0]?.name, "docs");
});

test("rejects home-relative traversal as unavailable", async () => {
  const root = tempRoot();
  const home = join(root, "home");
  const outside = join(root, "outside");
  mkdirSync(join(home, "docs"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  const catalog = createReferenceCatalogWithInfrastructure({ agentDir: join(root, "agent"), homeDir: home });
  await catalog.save({ references: { traversal: "~/../outside" } });
  const result = await catalog.read();
  const traversal = result.entries.find((item) => item.name === "traversal");
  assert.equal(traversal?.status, "unavailable");
  assert.equal(traversal?.path, undefined);
  assert.equal(traversal?.diagnostic, "Home-relative path escapes the configured home");
});

test("retains rejected relative local paths as unavailable entries", async () => {
  const root = tempRoot();
  const docs = join(root, "docs");
  mkdirSync(docs, { recursive: true });
  const catalog = createReferenceCatalogWithInfrastructure({ agentDir: join(root, "agent"), homeDir: root });
  mkdirSync(dirname(catalog.filePath), { recursive: true });
  writeFileSync(catalog.filePath, JSON.stringify({ references: { relative: "./docs", good: docs } }), "utf8");
  const result = await catalog.read();
  assert.equal(result.entries.find((item) => item.name === "relative")?.status, "unavailable");
  assert.equal(result.entries.find((item) => item.name === "relative")?.path, "./docs");
  assert.equal(result.entries.some((item) => item.name === "good"), true);
});

test("reports permission-blocked local roots as unavailable", async () => {
  const root = tempRoot();
  const blocked = join(root, "blocked");
  mkdirSync(blocked, { recursive: true });
  const previousMode = statSync(blocked).mode & 0o777;
  chmodSync(blocked, 0o000);
  try {
    const catalog = createReferenceCatalogWithInfrastructure({ agentDir: join(root, "agent"), homeDir: root });
    await catalog.save({ references: { blocked: join(blocked, "child") } });
    const result = await catalog.read();
    assert.equal(result.entries.find((item) => item.name === "blocked")?.status, "unavailable");
  } finally {
    chmodSync(blocked, previousMode);
  }
});

test("resolves local paths and reports unavailable roots without throwing", async () => {
  const root = tempRoot();
  const home = join(root, "home");
  const homeDocs = join(home, "docs");
  const absoluteDocs = join(root, "absolute");
  const fileRoot = join(root, "not-a-directory");
  mkdirSync(homeDocs, { recursive: true });
  mkdirSync(absoluteDocs, { recursive: true });
  writeFileSync(fileRoot, "file", "utf8");
  const catalog = createReferenceCatalogWithInfrastructure({
    agentDir: join(root, "agent"),
    homeDir: home,
    materializer: offlineMaterializer(),
  });
  await catalog.save({
    references: {
      home: "~/docs",
      absolute: absoluteDocs,
      missing: join(root, "missing"),
      file: fileRoot,
      sdk: { repository: "owner/repo", branch: "main" },
    },
  });

  const result = await catalog.read();
  assert.deepEqual(result.entries.map(({ name }) => name), ["absolute", "file", "home", "missing", "sdk"]);
  const byName = new Map(result.entries.map((item) => [item.name, item]));
  assert.equal(byName.get("home")?.path, realpathSync(homeDocs));
  assert.equal(byName.get("absolute")?.path, realpathSync(absoluteDocs));
  assert.equal(byName.get("home")?.status, "available");
  assert.equal(byName.get("absolute")?.status, "available");
  assert.equal(byName.get("missing")?.status, "unavailable");
  assert.equal(byName.get("file")?.status, "unavailable");
  assert.equal(byName.get("sdk")?.status, "unavailable");
});

test("keeps valid entries when strict JSON contains malformed entries", async () => {
  const root = tempRoot();
  const docs = join(root, "docs");
  mkdirSync(docs, { recursive: true });
  const catalog = createReferenceCatalogWithInfrastructure({
    agentDir: join(root, "agent"),
    homeDir: root,
    materializer: offlineMaterializer(),
  });
  mkdirSync(dirname(catalog.filePath), { recursive: true });
  writeFileSync(
    catalog.filePath,
    JSON.stringify({
      references: {
        good: docs,
        badBranch: { repository: "owner/repo", branch: null },
        badShape: { path: docs, repository: "owner/repo" },
      },
    }),
    "utf8",
  );

  const result = await catalog.read();
  assert.deepEqual(result.entries.map(({ name }) => name), ["badBranch", "badShape", "good"]);
  assert.equal(result.entries.find((entry) => entry.name === "badBranch")?.status, "unavailable");
  assert.equal(result.entries.find((entry) => entry.name === "badShape")?.status, "unavailable");
  assert.equal(result.diagnostics.length, 2);
  assert.ok(result.diagnostics.every((message) => !message.includes("owner/repo")));
});

test("rejects malformed JSON without exposing content", async () => {
  const root = tempRoot();
  const catalog = createReferenceCatalogWithInfrastructure({ agentDir: join(root, "agent"), homeDir: root });
  mkdirSync(dirname(catalog.filePath), { recursive: true });
  writeFileSync(catalog.filePath, "{ not strict json and secret-token }", "utf8");
  const result = await catalog.read();
  assert.deepEqual(result.entries, []);
  assert.equal(result.diagnostics.length, 1);
  assert.ok(!result.diagnostics[0]!.includes("secret-token"));
});

test("saves validated JSON atomically with mode 0644 and preserves the prior file on writer failure", async () => {
  const root = tempRoot();
  const catalog = createReferenceCatalogWithInfrastructure({ agentDir: join(root, "agent"), homeDir: root });
  const first = { references: { docs: "/tmp/docs" } };
  assert.deepEqual(await catalog.save(first), { ok: true });
  assert.equal(statSync(catalog.filePath).mode & 0o777, 0o644);
  assert.deepEqual(JSON.parse(readFileSync(catalog.filePath, "utf8")), first);

  const failing = createReferenceCatalogWithInfrastructure({
    agentDir: join(root, "agent"),
    homeDir: root,
    atomicWrite: async () => {
      throw new Error("simulated writer failure");
    },
  });
  const failed = await failing.save({ references: { changed: "/tmp/changed" } });
  assert.deepEqual(failed, { ok: false, error: "Unable to save references configuration" });
  assert.deepEqual(JSON.parse(readFileSync(catalog.filePath, "utf8")), first);
  assert.deepEqual(readdirSync(dirname(catalog.filePath)).filter((name) => name.includes(".tmp-")), []);

  const renameFailing = createReferenceCatalogWithInfrastructure({
    agentDir: join(root, "agent"),
    homeDir: root,
    fileSystem: {
      rename: async () => {
        throw new Error("simulated rename failure");
      },
    },
  });
  const renameFailed = await renameFailing.save({ references: { renamed: "/tmp/renamed" } });
  assert.deepEqual(renameFailed, { ok: false, error: "Unable to save references configuration" });
  assert.deepEqual(JSON.parse(readFileSync(catalog.filePath, "utf8")), first);
  assert.deepEqual(readdirSync(dirname(catalog.filePath)).filter((name) => name.includes(".tmp-")), []);
});

test("preflight rejects unavailable Git sources before persistence", async () => {
  const root = tempRoot();
  const catalog = createReferenceCatalogWithInfrastructure({
    agentDir: join(root, "agent"),
    homeDir: root,
    materializer: createInternalGitMaterializer({
      run: async (args) => {
        if (args[1] === "ls-remote") return { stdout: "", stderr: "" };
        throw new Error("should not materialize during preflight rejection");
      },
    }),
  });
  await catalog.save({ references: { docs: "/tmp/docs" } });
  const result = await catalog.save({ references: { remote: { repository: "owner/repo", branch: "main" } } });
  assert.deepEqual(result, { ok: false, error: "Git reference preflight failed" });
  assert.deepEqual(JSON.parse(readFileSync(catalog.filePath, "utf8")), { references: { docs: "/tmp/docs" } });
});

test("publishes Git materialization status through the public catalog", async () => {
  const root = tempRoot();
  const catalog = createReferenceCatalogWithInfrastructure({
    agentDir: join(root, "agent"),
    homeDir: root,
    materializer: {
      preflight: async () => ({ ok: true }),
      ensure: async () => ({
        localPath: join(root, "cache", "repo"),
        status: "cloned" as const,
        head: "abc123",
        branch: "main",
      }),
    },
  });
  assert.deepEqual(await catalog.save({ references: { remote: { repository: "owner/repo", branch: "main" } } }), { ok: true });
  const result = await catalog.read();
  const entry = result.entries[0]!;
  assert.equal(entry.status, "available");
  assert.equal(entry.materialization, "cloned");
  assert.equal(entry.path, join(root, "cache", "repo"));
});

test("save rejects invalid documents before touching the existing file", async () => {
  const root = tempRoot();
  const catalog = createReferenceCatalogWithInfrastructure({ agentDir: join(root, "agent"), homeDir: root });
  await catalog.save({ references: { docs: "/tmp/docs" } });
  const result = await catalog.save({ references: { relative: "./docs" } });
  assert.equal(result.ok, false);
  assert.deepEqual(JSON.parse(readFileSync(catalog.filePath, "utf8")), { references: { docs: "/tmp/docs" } });
});
