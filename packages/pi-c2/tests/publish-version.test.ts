import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { preparePublishManifest, validateReleaseVersion } from "../scripts/prepare-publish.ts";

const VALID_VERSION = "0.84.2-1.821.2026";

test("accepts the canonical release tag version", () => {
  assert.equal(validateReleaseVersion(VALID_VERSION), VALID_VERSION);
});

test("rejects prerelease numeric identifiers with leading zeroes", () => {
  assert.throws(
    () => validateReleaseVersion("0.84.2-001.0821.2026"),
    /valid semver release tag/,
  );
  assert.throws(
    () => validateReleaseVersion("0.84.2-1.0821.2026"),
    /valid semver release tag/,
  );
  assert.throws(
    () => validateReleaseVersion("0.84.2-1.821.2026+build.1"),
    /valid semver release tag/,
  );
});

test("writes the validated tag version into the publish manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "xzy-pi-c2-publish-version-"));
  try {
    const manifestPath = join(root, "package.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({ name: "@xzy-ai/pi-c2", version: "0.0.8", private: false }) + "\n",
    );

    const manifest = preparePublishManifest(root, VALID_VERSION);

    assert.equal(manifest.version, VALID_VERSION);
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).version, VALID_VERSION);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
