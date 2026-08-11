import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { cachePath, parseRepository } from "@xzy-ai/core";
import { createGitMaterializer } from "@xzy-ai/runtime";

function root(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-git-materializer-"));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function init(directory: string): void {
  mkdirSync(directory, { recursive: true });
  git(directory, "init", "--initial-branch=main");
  git(directory, "config", "user.email", "test@example.com");
  git(directory, "config", "user.name", "Reference Tests");
}

function commit(directory: string, content: string, message: string): string {
  writeFileSync(join(directory, "README.md"), content, "utf8");
  git(directory, "add", "README.md");
  git(directory, "commit", "-m", message);
  return git(directory, "rev-parse", "HEAD");
}

function repository(remote: string) {
  const parsed = parseRepository(pathToFileURL(remote).href);
  assert.ok(parsed);
  return parsed;
}

test("clones a local Git remote into a deterministic cache and reuses it", async () => {
  const rootDir = root();
  const remote = join(rootDir, "remote.git");
  init(remote);
  commit(remote, "main", "main");
  const materializer = createGitMaterializer();
  const reference = repository(remote);

  const cloned = await materializer.ensure({ reference, cacheRoot: join(rootDir, "cache") });
  assert.equal(cloned.status, "cloned");
  assert.equal(readFileSync(join(cloned.localPath, "README.md"), "utf8"), "main");
  const cached = await materializer.ensure({ reference, cacheRoot: join(rootDir, "cache") });
  assert.equal(cached.status, "cached");
  assert.equal(cached.localPath, cloned.localPath);
});

test("keeps explicit branch checkouts isolated from the default branch", async () => {
  const rootDir = root();
  const remote = join(rootDir, "remote");
  init(remote);
  commit(remote, "main", "main");
  git(remote, "checkout", "-b", "feature");
  commit(remote, "feature", "feature");
  git(remote, "checkout", "main");
  const materializer = createGitMaterializer();
  const reference = repository(remote);

  const feature = await materializer.ensure({ reference, cacheRoot: join(rootDir, "cache"), branch: "feature" });
  const main = await materializer.ensure({ reference, cacheRoot: join(rootDir, "cache") });
  assert.notEqual(feature.localPath, main.localPath);
  assert.equal(readFileSync(join(feature.localPath, "README.md"), "utf8"), "feature");
  assert.equal(readFileSync(join(main.localPath, "README.md"), "utf8"), "main");
});

test("refreshes a matching checkout and replaces an origin-mismatched cache", async () => {
  const rootDir = root();
  const remote = join(rootDir, "remote");
  init(remote);
  commit(remote, "one", "one");
  const materializer = createGitMaterializer();
  const reference = repository(remote);
  const first = await materializer.ensure({ reference, cacheRoot: join(rootDir, "cache") });
  commit(remote, "two", "two");
  const refreshed = await materializer.ensure({ reference, cacheRoot: join(rootDir, "cache"), refresh: true });
  assert.equal(refreshed.status, "refreshed");
  assert.equal(readFileSync(join(refreshed.localPath, "README.md"), "utf8"), "two");

  git(first.localPath, "config", "remote.origin.url", pathToFileURL(join(rootDir, "other.git")).href);
  writeFileSync(join(first.localPath, "stale.txt"), "stale", "utf8");
  const replaced = await materializer.ensure({ reference, cacheRoot: join(rootDir, "cache") });
  assert.equal(replaced.status, "cloned");
  assert.equal(readFileSync(join(replaced.localPath, "README.md"), "utf8"), "two");
});

test("replaces a checkout that is at the expected path but on the wrong branch", async () => {
  const rootDir = root();
  const remote = join(rootDir, "remote");
  init(remote);
  commit(remote, "main", "main");
  git(remote, "checkout", "-b", "feature");
  commit(remote, "feature", "feature");
  git(remote, "checkout", "main");
  const materializer = createGitMaterializer();
  const reference = repository(remote);
  const feature = await materializer.ensure({ reference, cacheRoot: join(rootDir, "cache"), branch: "feature" });
  git(feature.localPath, "checkout", "-b", "wrong");
  const repaired = await materializer.ensure({ reference, cacheRoot: join(rootDir, "cache"), branch: "feature" });
  assert.equal(repaired.status, "cloned");
  assert.equal(repaired.branch, "feature");
  assert.equal(readFileSync(join(repaired.localPath, "README.md"), "utf8"), "feature");
});

test("recovers a stale lock and cleans up a failed clone cache", async () => {
  const rootDir = root();
  const remote = join(rootDir, "remote");
  init(remote);
  commit(remote, "main", "main");
  const reference = repository(remote);
  const cacheRoot = join(rootDir, "cache");
  const localPath = cachePath(cacheRoot, reference);

  const lockPath = `${localPath}.lock`;
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(join(lockPath, "owner"), "stale-owner", "utf8");
  const old = new Date(Date.now() - 10_000);
  utimesSync(lockPath, old, old);
  const materializer = createGitMaterializer({ lockStaleMs: 100 });
  const cloned = await materializer.ensure({ reference, cacheRoot });
  assert.equal(cloned.status, "cloned");

  const failing = createGitMaterializer({
    run: async (args) => {
      if (args.includes("clone")) {
        throw new Error("clone failed");
      }
      throw new Error("unexpected command");
    },
  });
  await assert.rejects(failing.ensure({ reference, cacheRoot: join(rootDir, "failed-cache") }), /clone failed/);
  const failedPath = cachePath(join(rootDir, "failed-cache"), reference);
  assert.throws(() => readFileSync(join(failedPath, "README.md"), "utf8"));
});

test("serializes same-cache materialization and validates preflight branches", async () => {
  const rootDir = root();
  const remote = join(rootDir, "remote");
  init(remote);
  commit(remote, "main", "main");
  git(remote, "checkout", "-b", "feature");
  commit(remote, "feature", "feature");
  const materializer = createGitMaterializer();
  const reference = repository(remote);
  const results = await Promise.all([
    materializer.ensure({ reference, cacheRoot: join(rootDir, "cache"), branch: "feature" }),
    materializer.ensure({ reference, cacheRoot: join(rootDir, "cache"), branch: "feature" }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["cached", "cloned"]);
  assert.deepEqual(await materializer.preflight({ reference, branch: "feature" }), { ok: true });
  assert.equal((await materializer.preflight({ reference, branch: "missing" })).ok, false);
  assert.equal((await materializer.preflight({ reference, branch: "../unsafe" })).ok, false);
});

test("applies operation timeouts and never exposes credentials in failures", async () => {
  const rootDir = root();
  const script = join(rootDir, "fake-git");
  writeFileSync(script, "#!/bin/sh\nsleep 2\n", "utf8");
  chmodSync(script, 0o755);
  const reference = repository(join(rootDir, "remote"));
  const materializer = createGitMaterializer({ timeoutMs: 25, gitExecutable: script });
  await assert.rejects(
    materializer.ensure({ reference, cacheRoot: join(rootDir, "cache") }),
    (error: unknown) => !String(error).includes("https://"),
  );

  const secret = "super-secret-token";
  const failing = createGitMaterializer({
    run: async () => {
      throw new Error(`remote https://user:${secret}@example.com/org/repo.git failed`);
    },
  });
  const credentialed = repository(`https://user:${secret}@example.com/org/repo.git`);
  await assert.rejects(
    failing.ensure({ reference: credentialed, cacheRoot: join(rootDir, "failure-cache") }),
    (error: unknown) => !String(error).includes(secret),
  );
});