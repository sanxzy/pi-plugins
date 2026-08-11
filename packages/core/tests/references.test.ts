import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cacheIdentity,
  cachePath,
  parseRepository,
  validateBranch,
  validateReferenceAlias,
  validateReferenceCatalog,
  validateReferenceEntry,
} from "@xzy-ai/core";

test("validates local and Git reference shorthands and object metadata", () => {
  assert.deepEqual(validateReferenceEntry("docs", "~/docs"), {
    ok: true,
    value: { type: "local", path: "~/docs" },
  });
  assert.deepEqual(validateReferenceEntry("sdk", "owner/repo"), {
    ok: true,
    value: { type: "git", repository: "owner/repo" },
  });

  const local = validateReferenceEntry("docs", {
    path: "/srv/docs",
    description: "API docs",
    hidden: true,
  });
  assert.deepEqual(local, {
    ok: true,
    value: { type: "local", path: "/srv/docs", description: "API docs", hidden: true },
  });

  const git = validateReferenceEntry("sdk", {
    repository: "owner/repo",
    branch: "feature/docs",
    description: "SDK source",
    hidden: false,
  });
  assert.deepEqual(git, {
    ok: true,
    value: {
      type: "git",
      repository: "owner/repo",
      branch: "feature/docs",
      description: "SDK source",
      hidden: false,
    },
  });
});

test("accepts a strict catalog document and preserves deterministic source entries", () => {
  const result = validateReferenceCatalog({
    references: {
      docs: "~/docs",
      sdk: { repository: "github.com/owner/sdk", branch: "main" },
    },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, {
      references: {
        docs: { type: "local", path: "~/docs" },
        sdk: { type: "git", repository: "github.com/owner/sdk", branch: "main" },
      },
    });
  }
});

test("rejects unsafe aliases, malformed entries, and relative local paths", () => {
  for (const alias of ["", "has space", "a/b", "a\\b", "a,b", "a`b"]) {
    assert.equal(validateReferenceAlias(alias).ok, false, alias);
  }
  assert.equal(validateReferenceEntry("docs", "./docs").ok, false);
  assert.equal(validateReferenceEntry("docs", "../docs").ok, false);
  assert.equal(validateReferenceEntry("docs", { path: "docs" }).ok, false);
  assert.equal(validateReferenceEntry("docs", { path: "/srv/docs", hidden: "yes" }).ok, false);
  assert.equal(validateReferenceEntry("docs", { path: "/srv/docs", repository: "owner/repo" }).ok, false);
  assert.equal(validateReferenceEntry("docs", { repository: "owner/repo", branch: "bad branch" }).ok, false);
});

test("rejects unsafe repositories and branches without echoing sensitive input", () => {
  const secret = "https://user:super-secret@example.com/owner/repo";
  const result = validateReferenceEntry("private", { repository: secret, branch: "main" });
  assert.equal(result.ok, true);

  const invalid = validateReferenceEntry("private", {
    repository: "../../etc/passwd",
    branch: "main",
  });
  assert.equal(invalid.ok, false);
  assert.ok(!JSON.stringify(invalid).includes("passwd"));

  const branch = validateBranch("feature/docs.v1");
  assert.deepEqual(branch, { ok: true, value: "feature/docs.v1" });
  for (const unsafe of ["", "-bad", "bad..branch", "bad branch", "bad\\branch"]) {
    assert.equal(validateBranch(unsafe).ok, false, unsafe);
  }
});

test("normalizes equivalent repositories and isolates slash-containing branches", () => {
  const shorthand = parseRepository("owner/repo");
  const https = parseRepository("https://github.com/owner/repo.git");
  const hostPath = parseRepository("github.com/owner/repo/");
  assert.ok(shorthand);
  assert.ok(https);
  assert.ok(hostPath);
  assert.equal(cacheIdentity(shorthand), cacheIdentity(https));
  assert.equal(cacheIdentity(shorthand), cacheIdentity(hostPath));
  assert.equal(cachePath("/cache", shorthand, "feature/docs"), "/cache/github.com/owner/repo@feature%2Fdocs");
  assert.notEqual(cachePath("/cache", shorthand, "main"), cachePath("/cache", shorthand, "feature/docs"));
});

test("supports deterministic file Git repositories for isolated tests", () => {
  const repository = parseRepository("file:///tmp/reference-fixture.git");
  assert.ok(repository);
  assert.equal(repository.protocol, "file:");
  assert.equal(repository.host, "file");
  assert.equal(repository.path, "/tmp/reference-fixture.git");
});
