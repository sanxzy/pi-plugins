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
  ["dist/core/agent-session.js", "advance round-robin groups on every individual model request"],
  ["dist/core/agent-session.js", "quarantine group members on HTTP 4xx/5xx"],
  ["dist/core/agent-session.js", "pi-c2.child-model-bindings"],
  ["dist/modes/interactive/components/model-selector.js", "pi-c2: the extension publishes a host-neutral model-group bridge"],
  ["dist/modes/interactive/interactive-mode.js", "__pi_c2_group__"],
  ["dist/modes/interactive/interactive-mode.js", "hostSwapApplyChildEvent"],
  ["dist/modes/interactive/interactive-mode.js", "hostSwapQueueChildMessage"],
  ["dist/modes/interactive/interactive-mode.js", "_hostGetThemeInstance"],
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
  // The workspace dependency carries the same complete host patch as the
  // bundled postinstall patch. Reverse the complete patch so the fixture
  // remains pristine even when new host capabilities are added.
  const reversed = reversePatch(parsePatch(bundledPatch));
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
    const sdkDir = join(root, "@earendil-works", "pi-coding-agent");
    const revisionFile = sdkDir + ".pi-c2-patch-revision";
    assert.ok(existsSync(revisionFile), "applying must record the patch revision");
    const second = runScript(npmBin);
    assert.match(second.stdout, /nothing to do/);
    assert.equal(second.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("postinstall upgrades a patched host whose revision is stale", async () => {
  const { createHash } = await import("node:crypto");
  const { root, npmBin } = await fakeGlobal();
  try {
    // First run: patch + record revision.
    runScript(npmBin);
    const sdkDir = join(root, "@earendil-works", "pi-coding-agent");
    const revisionFile = sdkDir + ".pi-c2-patch-revision";
    assert.ok(existsSync(revisionFile));
    // Simulate an OLDER deployed revision.
    writeFileSync(revisionFile, "stale-revision-hash\n");

    const { status, stdout } = runScript(npmBin);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /revision|upgrad/i, "stale revision must trigger an upgrade, not a skip");

    const bundled = createHash("sha256").update(readFileSync(PATCH_FILE)).digest("hex");
    assert.equal(readFileSync(revisionFile, "utf8").trim(), bundled, "revision updated to the bundled hash");
    for (const [rel, needle] of PATCH_MARKERS) {
      assert.ok(readFileSync(join(sdkDir, rel), "utf8").includes(needle));
    }
    // The pristine backup survives the upgrade cycle.
    assert.ok(
      !readFileSync(join(root, "@earendil-works", "pi-coding-agent.bak-0.84.2", "dist/core/extensions/loader.js"), "utf8").includes("createCommandContext"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("postinstall upgrades a legacy patched host that has no revision file", async () => {
  const { root, npmBin } = await fakeGlobal();
  try {
    runScript(npmBin);
    const sdkDir = join(root, "@earendil-works", "pi-coding-agent");
    const revisionFile = sdkDir + ".pi-c2-patch-revision";
    rmSync(revisionFile);
    // Also simulate legacy CONTENT: strip the newest capability block so the
    // marker set alone would call this host outdated.
    const agentSession = join(sdkDir, "dist/core/agent-session.js");
    writeFileSync(agentSession, readFileSync(agentSession, "utf8").replaceAll('Symbol.for("pi-c2.child-model-bindings")', "undefined"));

    const { status, stdout } = runScript(npmBin);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /patched host pi-coding-agent/);
    assert.ok(readFileSync(agentSession, "utf8").includes("pi-c2.child-model-bindings"), "legacy host gains the binding-aware hooks");
    assert.ok(existsSync(revisionFile), "upgrade records the new revision");
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
