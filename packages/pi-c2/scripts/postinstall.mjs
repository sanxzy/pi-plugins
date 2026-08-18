#!/usr/bin/env node
/**
 * pi-c2 postinstall: apply the pi-coding-agent host patch automatically.
 *
 * The pi-c2 extension depends on three host-side capabilities that are not
 * present in every `@earendil-works/pi-coding-agent` install:
 *
 *   1. `registerEntryRenderer` (stock 0.84.2+; the yellow ※ notify entry)
 *   2. `createCommandContext` (patched; telegram lifecycle/controls seam)
 *   3. `sessionFilename`/`privateRoot` (patched; private child-session storage)
 *
 * This script locates the HOST's pi-coding-agent (the one the pi CLI runs),
 * checks its version and patch state, and if the host is 0.84.2+ and not yet
 * patched, backs it up and applies the bundled patch with a pure-JS unified
 * diff applier (no git, no .git dir, no external tools). It is idempotent:
 * already-patched hosts are left untouched.
 *
 * The script never throws — an npm postinstall failure is confusing for
 * users. Every outcome prints a clear one-line status.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPatches } from "diff";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PATCH_FILE = join(SCRIPT_DIR, "pi-coding-agent@0.84.2.patch");
const MIN_VERSION = [0, 84, 2];

/** Marker strings that only exist after the patch is applied. */
const PATCH_MARKERS = [
  "dist/core/extensions/loader.js:createCommandContext",
  "dist/core/session-manager.js:ensurePrivateSessionDir",
];

function log(message) {
  console.log(`[pi-c2 postinstall] ${message}`);
}

function versionTuple(version) {
  const cleaned = String(version ?? "")
    .replace(/^[^\d]+/, "")
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  while (cleaned.length < 3) cleaned.push(0);
  return cleaned;
}

function satisfiesMin(version) {
  const v = versionTuple(version);
  for (let i = 0; i < 3; i++) {
    if (v[i] > MIN_VERSION[i]) return true;
    if (v[i] < MIN_VERSION[i]) return false;
  }
  return true;
}

/**
 * Resolve the HOST pi-coding-agent directory.
 *
 * Strategy: if we are installed flat in a global node_modules (npm -g puts
 * every package at the root), the host SDK is our sibling. Otherwise fall back
 * to `npm root -g`. The host is the copy pi actually loads, so prefer the
 * one reachable from the running CLI's own module tree.
 */
function resolveHostSdk() {
  // 1. npm root -g is the authoritative global install root.
  let globalRoot = null;
  try {
    globalRoot = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    /* npm not on PATH in the install context */
  }
  if (globalRoot) {
    const candidate = join(globalRoot, "@earendil-works", "pi-coding-agent");
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  // 2. We are a sibling of the host SDK (flat global layout).
  let current = resolve(SCRIPT_DIR);
  for (let depth = 0; depth < 6 && dirname(current) !== current; depth++) {
    const candidate = join(current, "@earendil-works", "pi-coding-agent");
    if (existsSync(join(candidate, "package.json"))) return candidate;
    current = dirname(current);
  }
  // 3. Local workspace install (dev/test).
  const local = resolve(join(SCRIPT_DIR, "..", "..", "..", "..", "node_modules", "@earendil-works", "pi-coding-agent"));
  if (existsSync(join(local, "package.json"))) return local;
  return null;
}

/** True when every marker file+needle is present (patch applied). */
function isPatched(sdkDir) {
  return PATCH_MARKERS.every((marker) => {
    const [relPath, needle] = marker.split(":");
    const file = join(sdkDir, relPath);
    if (!existsSync(file)) return false;
    return readFileSync(file, "utf8").includes(needle);
  });
}

/** Strip the `a/` / `b/` prefix that unified diffs add to file names. */
function normalizePatchPath(name) {
  const cleaned = String(name ?? "");
  if (cleaned.startsWith("a/") || cleaned.startsWith("b/")) return cleaned.slice(2);
  return cleaned;
}

/**
 * Apply every hunk of the bundled patch to the SDK dir with `diff.applyPatches`.
 * Returns the list of files that changed.
 */
function applyPatchToSdk(sdkDir) {
  const patchText = readFileSync(PATCH_FILE, "utf8");
  const changed = [];
  let failed = null;
  return new Promise((resolvePromise, reject) => {
    applyPatches(patchText, {
      fuzzFactor: 0,
      loadFile(index, callback) {
        try {
          const file = join(sdkDir, normalizePatchPath(index.newFileName ?? index.fileName));
          if (!existsSync(file)) return callback(new Error(`patch target missing: ${file}`));
          callback(null, readFileSync(file, "utf8"));
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
      patched(index, content, callback) {
        try {
          if (content === false) {
            return callback(new Error(`patch did not apply cleanly to ${normalizePatchPath(index.newFileName ?? index.fileName)}`));
          }
          const rel = normalizePatchPath(index.newFileName ?? index.fileName);
          const file = join(sdkDir, rel);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, content);
          changed.push(rel);
          callback(null);
        } catch (error) {
          failed = error instanceof Error ? error : new Error(String(error));
          callback(failed);
        }
      },
      complete(error) {
        if (error) reject(error);
        else if (failed) reject(failed);
        else resolvePromise(changed);
      },
    });
  });
}

let hostSdk = null;
let backupDir = null;
try {
  if (!existsSync(PATCH_FILE)) {
    log("patch bundle missing; skipping host patch");
    process.exit(0);
  }
  hostSdk = resolveHostSdk();
  if (!hostSdk) {
    log("could not locate the host pi-coding-agent; skipping (extension still works, with degraded features)");
    process.exit(0);
  }
  const pkg = JSON.parse(readFileSync(join(hostSdk, "package.json"), "utf8"));
  const version = pkg.version ?? "0.0.0";
  if (!satisfiesMin(version)) {
    log(`host pi-coding-agent is ${version}; the yellow ※ notification requires >= 0.84.2. Please upgrade pi.`);
    process.exit(0);
  }
  if (isPatched(hostSdk)) {
    log(`host pi-coding-agent ${version} already patched; nothing to do`);
    process.exit(0);
  }
  // Back up the pristine host SDK so the patch is reversible. If a backup from
  // a prior run exists, restore it first so the copy we patch is pristine.
  backupDir = `${hostSdk}.bak-${version}`;
  if (existsSync(backupDir)) {
    rmSync(hostSdk, { recursive: true, force: true });
    cpSync(backupDir, hostSdk, { recursive: true });
  } else {
    cpSync(hostSdk, backupDir, { recursive: true });
  }
  const changed = await applyPatchToSdk(hostSdk);
  if (isPatched(hostSdk)) {
    log(`patched host pi-coding-agent ${version}: ${changed.join(", ")}. Backup kept at ${backupDir}`);
  } else {
    // Verification failed: restore pristine.
    rmSync(hostSdk, { recursive: true, force: true });
    cpSync(backupDir, hostSdk, { recursive: true });
    log(`patch verification failed; restored pristine host from backup`);
  }
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  // Best-effort rollback if we created a backup.
  if (hostSdk && backupDir && existsSync(backupDir) && existsSync(hostSdk)) {
    try {
      rmSync(hostSdk, { recursive: true, force: true });
      cpSync(backupDir, hostSdk, { recursive: true });
      log(`postinstall failed (${detail}); restored pristine host from backup`);
      process.exit(0);
    } catch {
      /* leave both; the backup is the safety net */
    }
  }
  log(`postinstall error: ${detail}. The extension still loads; features that need the patch degrade gracefully.`);
  process.exit(0);
}
