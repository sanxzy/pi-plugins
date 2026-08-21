import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { parsePatch, reversePatch, applyPatches } from "diff";

const SCRIPT = new URL("../scripts/postinstall.mjs", import.meta.url).pathname;
const PATCH_FILE = new URL("../scripts/pi-coding-agent@0.84.2.patch", import.meta.url).pathname;
const SDK_SOURCE = new URL("../node_modules/@earendil-works/pi-coding-agent", import.meta.url).pathname;

/** Marker strings that only exist after the patch is applied. */
const PATCH_MARKERS: Array<[string, string]> = [
  ["dist/core/extensions/loader.js", "createCommandContext"],
  ["dist/core/session-manager.js", "ensurePrivateSessionDir"],
  ["dist/core/settings-manager.js", "thresholdPercentOverride"],
  ["dist/core/agent-session.js", "_maybeAbortForThreshold"],
  ["dist/modes/interactive/components/model-selector.js", "pi-c2: the extension publishes a host-neutral model-group bridge"],
  ["dist/modes/interactive/interactive-mode.js", "__pi_c2_group__"],
];

/**
 * Build a pristine (unpatched) 0.84.2 SDK copy by reverse-applying the bundled
 * patch to the workspace's already-patched SDK. Deterministic, offline.
 */
async function buildPristineSdk(): Promise<string> {
  const dest = mkdtempSync(join(tmpdir(), "pi-c2-pristine-sdk-"));
  // Copy only what the postinstall reads (package.json + dist) to avoid
  // pnpm's `.bin` symlinks that cannot be re-created in a temp dir.
  cpSync(join(SDK_SOURCE, "package.json"), join(dest, "package.json"));
  cpSync(join(SDK_SOURCE, "dist"), join(dest, "dist"), { recursive: true });
  const bundledPatch = readFileSync(PATCH_FILE, "utf8");
  // The workspace dependency is already patched with the historical host patch,
  // while the model-group hunks are this package's new postinstall surface. Build
  // a pristine fixture by reversing only the historical portion, then let the
  // postinstall script apply the complete bundled patch.
  const groupMarker = bundledPatch.indexOf('+                    if (model.provider === "__pi_c2_group__")');
  const groupHunk = groupMarker > 0 ? bundledPatch.lastIndexOf("\n@@", groupMarker) + 1 : -1;
  assert.ok(groupHunk > 0, "bundled patch must contain the model-group activation hunk");
  const patchText = bundledPatch.slice(0, groupHunk).trimEnd() + "\n";
  const reversed = reversePatch(parsePatch(patchText));
  await new Promise<void>((resolve, reject) => {
    applyPatches(reversed, {
      loadFile(index, callback) {
        const rel = String(index.newFileName ?? "").replace(/^[ab]\//, "");
        const file = join(dest, rel);
        callback(null, existsSync(file) ? readFileSync(file, "utf8") : "");
      },
      patched(index, content, callback) {
        const rel = String(index.newFileName ?? "").replace(/^[ab]\//, "");
        writeFileSync(join(dest, rel), content === false ? "" : content);
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

/** Create a fake global root with a pristine SDK + a stub `npm` bin. */
async function fakeGlobal(): Promise<{ root: string; npmBin: string }> {
  const root = mkdtempSync(join(tmpdir(), "pi-c2-fake-global-"));
  const sdkDir = join(root, "@earendil-works", "pi-coding-agent");
  const pristine = await buildPristineSdk();
  cpSync(pristine, sdkDir, { recursive: true });
  rmSync(pristine, { recursive: true, force: true });
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "npm"),
    "#!/bin/bash\nif [ \"$1\" = \"root\" ] && [ \"$2\" = \"-g\" ]; then echo \"" + root + "\"; exit 0; fi\nexit 1\n",
  );
  chmodSync(join(bin, "npm"), 0o755);
  return { root, npmBin: bin };
}

function runScript(npmBin: string): { status: number; stdout: string } {
  const result = spawnSync("node", [SCRIPT], {
    env: { ...process.env, PATH: `${npmBin}:${process.env.PATH ?? ""}` },
    encoding: "utf8",
  });
  return { status: result.status ?? -1, stdout: result.stdout + result.stderr };
}

test("postinstall patches an unpatched 0.84.2 host and keeps a pristine backup", async () => {
  const { root, npmBin } = await fakeGlobal();
  try {
    const sdkDir = join(root, "@earendil-works", "pi-coding-agent");
    // Precondition: pristine.
    assert.equal(
      readFileSync(join(sdkDir, "dist/core/extensions/loader.js"), "utf8").includes("createCommandContext"),
      false,
      "fixture must start unpatched",
    );
    const { status, stdout } = runScript(npmBin);
    assert.equal(status, 0, `script must exit 0, got ${status}: ${stdout}`);
    assert.match(stdout, /patched host pi-coding-agent 0\.84\.2/);
    for (const [rel, needle] of PATCH_MARKERS) {
      assert.ok(readFileSync(join(sdkDir, rel), "utf8").includes(needle), `${rel} must contain ${needle}`);
    }
    // Backup exists and is pristine.
    const backup = join(root, "@earendil-works", "pi-coding-agent.bak-0.84.2");
    assert.ok(existsSync(backup), "backup must exist");
    assert.equal(
      readFileSync(join(backup, "dist/core/extensions/loader.js"), "utf8").includes("createCommandContext"),
      false,
      "backup must be pristine",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("postinstall is idempotent on an already-patched host", async () => {
  const { root, npmBin } = await fakeGlobal();
  try {
    const first = runScript(npmBin);
    assert.match(first.stdout, /patched host/);
    const second = runScript(npmBin);
    assert.match(second.stdout, /already patched; nothing to do/);
    assert.equal(second.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("postinstall skips a host older than 0.84.2", async () => {
  const { root, npmBin } = await fakeGlobal();
  try {
    const pkgPath = join(root, "@earendil-works", "pi-coding-agent", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.version = "0.80.2";
    writeFileSync(pkgPath, JSON.stringify(pkg));
    const { status, stdout } = runScript(npmBin);
    assert.equal(status, 0);
    assert.match(stdout, /requires >= 0\.84\.2/);
    // Host untouched.
    const sdkDir = join(root, "@earendil-works", "pi-coding-agent");
    assert.equal(
      readFileSync(join(sdkDir, "dist/core/extensions/loader.js"), "utf8").includes("createCommandContext"),
      false,
      "old host must not be patched",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("postinstall restores the pre-script host state when the patch cannot apply", async () => {
  const { root, npmBin } = await fakeGlobal();
  try {
    const sdkDir = join(root, "@earendil-works", "pi-coding-agent");
    // Replace a patch target with a directory so the write fails mid-apply.
    // The script backs up the host first, so the rollback restores exactly the
    // pre-script state (the directory stays, but the SDK dir is intact).
    const target = join(sdkDir, "dist/core/session-manager.js");
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    const { status, stdout } = runScript(npmBin);
    assert.equal(status, 0);
    assert.match(stdout, /restored pristine host/);
    // The SDK dir must remain a valid tree (package.json present).
    assert.ok(existsSync(join(sdkDir, "package.json")), "host SDK dir must remain intact");
    // No half-applied markers: the patch must not be partially present.
    assert.equal(
      readFileSync(join(sdkDir, "dist/core/extensions/loader.js"), "utf8").includes("createCommandContext"),
      false,
      "failed patch must not leave partial markers",
    );
    // Backup is retained as the recovery safety net.
    assert.ok(existsSync(join(root, "@earendil-works", "pi-coding-agent.bak-0.84.2")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
