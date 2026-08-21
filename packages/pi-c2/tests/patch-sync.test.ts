import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { applyPatches, parsePatch, reversePatch } from "diff";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_PATCH = join(HERE, "../scripts/pi-coding-agent@0.84.2.patch");
const WORKSPACE_PATCH = new URL("../../../patches/@earendil-works__pi-coding-agent@0.84.2.patch", import.meta.url).pathname;
const SDK_SOURCE = new URL("../node_modules/@earendil-works/pi-coding-agent", import.meta.url).pathname;

/** Capability markers every patched host must expose for pi-c2 theme/swap features. */
const CAPABILITY_MARKERS: Array<[string, string]> = [
  ["dist/modes/interactive/interactive-mode.js", "_hostInteractiveMode"],
  ["dist/modes/interactive/interactive-mode.js", "__piHostInteractiveMode"],
  ["dist/modes/interactive/interactive-mode.js", "_hostGetThemeInstance"],
  ["dist/modes/interactive/interactive-mode.js", "hostSwapToSnapshot"],
  ["dist/modes/interactive/interactive-mode.js", "hostSwapUpdateSnapshot"],
  ["dist/modes/interactive/interactive-mode.js", "hostSwapApplyChildEvent"],
  ["dist/modes/interactive/interactive-mode.js", "hostSwapRestore"],
];

function sdkFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sdkFiles(full, base));
    else out.push(relative(base, full));
  }
  return out.sort();
}

async function applyTo(copyFrom: string, patchText: string, reverse = false): Promise<string> {
  const dest = mkdtempSync(join(tmpdir(), "pi-c2-patch-fixture-"));
  cpSync(join(copyFrom, "package.json"), join(dest, "package.json"));
  cpSync(join(copyFrom, "dist"), join(dest, "dist"), { recursive: true });
  const parsed = parsePatch(patchText);
  const patch = reverse ? reversePatch(parsed) : parsed;
  await new Promise<void>((resolve, reject) => {
    applyPatches(patch as never, {
      loadFile(index, callback) {
        const rel = String(index.newFileName ?? "").replace(/^[ab]\//, "");
        const file = join(dest, rel);
        callback(null, existsSync(file) ? readFileSync(file, "utf8") : "");
      },
      patched(index, content, callback) {
        const rel = String(index.newFileName ?? "").replace(/^[ab]\//, "");
        if (content === false) return callback(new Error(`patch did not apply to ${rel}`));
        mkdirSync(dirname(join(dest, rel)), { recursive: true });
        writeFileSync(join(dest, rel), content);
        callback(null);
      },
      complete(error) {
        if (error) reject(error);
        else resolve();
      },
    });
  });
  return dest;
}

/** Build one pristine (unpatched) SDK fixture by reverse-applying the bundled patch. */
async function makePristine(bundledText: string): Promise<string> {
  return applyTo(SDK_SOURCE, bundledText, true);
}

test("workspace and bundled host patches are semantically synchronized", async () => {
  assert.ok(existsSync(BUNDLED_PATCH), "bundled patch must exist");
  assert.ok(existsSync(WORKSPACE_PATCH), "workspace patch must exist");
  const bundledText = readFileSync(BUNDLED_PATCH, "utf8");
  const workspaceText = readFileSync(WORKSPACE_PATCH, "utf8");
  const pristine = await makePristine(bundledText);
  try {
    const withBundled = await applyTo(pristine, bundledText);
    try {
      const withWorkspace = await applyTo(pristine, workspaceText);
      try {
        const expected = sdkFiles(withBundled);
        assert.deepEqual(sdkFiles(withWorkspace), expected);
        for (const rel of expected) {
          assert.equal(
            readFileSync(join(withWorkspace, rel), "utf8"),
            readFileSync(join(withBundled, rel), "utf8"),
            `${rel} must be identical under both patches`,
          );
        }
      } finally {
        rmSync(withWorkspace, { recursive: true, force: true });
      }
    } finally {
      rmSync(withBundled, { recursive: true, force: true });
    }
  } finally {
    rmSync(pristine, { recursive: true, force: true });
  }
});

test("capability markers exist in the patched host and the patch reverses cleanly", async () => {
  const bundledText = readFileSync(BUNDLED_PATCH, "utf8");
  const pristineCopy = await makePristine(bundledText);
  const patched = await applyTo(pristineCopy, bundledText);
  try {
    for (const [rel, needle] of CAPABILITY_MARKERS) {
      assert.ok(readFileSync(join(patched, rel), "utf8").includes(needle), `${rel} must contain ${needle}`);
    }
    // Reverse-applying the bundled patch restores the exact pristine bytes.
    const reversed = await applyTo(patched, bundledText, true);
    try {
      for (const rel of sdkFiles(reversed)) {
        assert.equal(readFileSync(join(reversed, rel), "utf8"), readFileSync(join(pristineCopy, rel), "utf8"), `${rel} must match pristine after reversal`);
      }
    } finally {
      rmSync(reversed, { recursive: true, force: true });
    }
  } finally {
    rmSync(patched, { recursive: true, force: true });
    rmSync(pristineCopy, { recursive: true, force: true });
  }
});
