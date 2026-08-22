import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_PATCH = join(HERE, "../scripts/pi-coding-agent@0.84.2.patch");
const WORKSPACE_PATCH = new URL("../../../patches/@earendil-works__pi-coding-agent@0.84.2.patch", import.meta.url).pathname;

/**
 * The patched AgentSession hooks must respect per-session model bindings
 * published by the child adapter under `pi-c2.child-model-bindings`:
 *
 *   - pinned sessions are never switched or failed over by group mechanics;
 *   - group-bound sessions rotate/fail over inside their NAMED group;
 *   - unbound sessions keep following the home-wide active selection.
 */
test("the bundled patch gates turn_start rotation on the session model binding", () => {
  const patch = readFileSync(BUNDLED_PATCH, "utf8");
  assert.match(patch, /pi-c2\.child-model-bindings/, "patch reads the child binding registry");
  assert.match(patch, /getChildModelBinding\(this\.sessionId\)/, "turn_start looks up the binding by session id");
  assert.match(patch, /sessionBinding\?\.kind !== "pinned"/, "pinned sessions skip group rotation entirely");
  assert.match(patch, /resolveActive\(boundGroupId\)/, "group-bound sessions advance their named group");
});

test("the bundled patch gates failure fail-over on the session model binding", () => {
  const patch = readFileSync(BUNDLED_PATCH, "utf8");
  assert.match(patch, /reportFailure\(currentRef,\s*boundGroupId\)/, "failure path quarantines inside the bound group");
});

test("the workspace patch copy matches the bundled copy byte for byte", () => {
  const bundled = readFileSync(BUNDLED_PATCH, "utf8");
  const workspace = readFileSync(WORKSPACE_PATCH, "utf8");
  assert.equal(bundled, workspace);
});
