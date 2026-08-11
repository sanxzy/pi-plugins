import assert from "node:assert/strict";
import {
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
import {
  createReferenceCatalog,
  referenceConfigFile,
} from "@xzy-ai/runtime";

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
  const catalog = createReferenceCatalog({ agentDir: join(root, "agent"), homeDir: join(root, "home") });
  assert.deepEqual(await catalog.read(), { entries: [], diagnostics: [] });

  mkdirSync(dirname(catalog.filePath), { recursive: true });
  writeFileSync(catalog.filePath, JSON.stringify({ references: { docs: "/tmp/docs" } }), "utf8");
  const reread = await catalog.read();
  assert.equal(reread.entries.length, 1);
  assert.equal(reread.entries[0]?.name, "docs");
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
  const catalog = createReferenceCatalog({ agentDir: join(root, "agent"), homeDir: home });
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
  const catalog = createReferenceCatalog({ agentDir: join(root, "agent"), homeDir: root });
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
  assert.deepEqual(result.entries.map(({ name }) => name), ["good"]);
  assert.equal(result.diagnostics.length, 2);
  assert.ok(result.diagnostics.every((message) => !message.includes("owner/repo")));
});

test("rejects malformed JSON without exposing content", async () => {
  const root = tempRoot();
  const catalog = createReferenceCatalog({ agentDir: join(root, "agent"), homeDir: root });
  mkdirSync(dirname(catalog.filePath), { recursive: true });
  writeFileSync(catalog.filePath, "{ not strict json and secret-token }", "utf8");
  const result = await catalog.read();
  assert.deepEqual(result.entries, []);
  assert.equal(result.diagnostics.length, 1);
  assert.ok(!result.diagnostics[0]!.includes("secret-token"));
});

test("saves validated JSON atomically with mode 0644 and preserves the prior file on writer failure", async () => {
  const root = tempRoot();
  const catalog = createReferenceCatalog({ agentDir: join(root, "agent"), homeDir: root });
  const first = { references: { docs: "/tmp/docs" } };
  assert.deepEqual(await catalog.save(first), { ok: true });
  assert.equal(statSync(catalog.filePath).mode & 0o777, 0o644);
  assert.deepEqual(JSON.parse(readFileSync(catalog.filePath, "utf8")), first);

  const failing = createReferenceCatalog({
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
});

test("save rejects invalid documents before touching the existing file", async () => {
  const root = tempRoot();
  const catalog = createReferenceCatalog({ agentDir: join(root, "agent"), homeDir: root });
  await catalog.save({ references: { docs: "/tmp/docs" } });
  const result = await catalog.save({ references: { relative: "./docs" } });
  assert.equal(result.ok, false);
  assert.deepEqual(JSON.parse(readFileSync(catalog.filePath, "utf8")), { references: { docs: "/tmp/docs" } });
});

