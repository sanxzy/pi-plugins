import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, "../scripts/build.mjs");
const DIST = join(HERE, "../dist");

test("the publishable bundle embeds built-in theme profile data", () => {
  execFileSync(process.execPath, [BUILD], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.ok(existsSync(join(DIST, "index.js")), "bundle must exist");
  assert.ok(existsSync(join(DIST, "scripts", "pi-coding-agent@0.84.2.patch")), "bundled host patch must ship");
  const bundle = readFileSync(join(DIST, "index.js"), "utf8");
  // Embedded built-in profiles must be present verbatim (theme anchors).
  assert.ok(bundle.includes("#bd93f9"), "dracula profile data must be embedded");
  assert.ok(bundle.includes("#88c0d0"), "nord profile data must be embedded");
  // The bundle must not load built-in profiles from an unbundled local file.
  assert.ok(!/readFileSync\([^)]*themes?\.json/.test(bundle), "bundle must not read a local themes file for built-ins");
});
