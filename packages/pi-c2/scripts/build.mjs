#!/usr/bin/env node
/**
 * Build the publish-ready layout for @xzy-ai/pi-c2.
 *
 * The extension is loaded by pi via jiti directly from TypeScript, and it
 * imports workspace packages (@xzy-ai/*) that are never published on their
 * own. To make the published package self-contained, we bundle index.ts with
 * esbuild, inlining every @xzy-ai/* module, while keeping the host SDK
 * (@earendil-works/*), the postinstall's `diff`, and the transitive CJS deps
 * that the bundled code loads dynamically (createRequire) external.
 *
 * Output layout (dist/):
 *   index.js                  bundled extension (default-export factory)
 *   package.json              publish-ready manifest
 *   scripts/postinstall.mjs   host patch applier (ships as source)
 *   scripts/pi-coding-agent@0.84.2.patch
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(here);
const workspaceRoot = dirname(dirname(dirname(here))); // plugins/
const distDir = join(pkgRoot, "dist");

/** Explicit externals: host SDKs (resolved from the pi host at runtime) + the
 * postinstall's diff. Everything else, including all @xzy-ai/* workspace
 * packages, is bundled inline unless it is loaded dynamically. */
const EXPLICIT_EXTERNAL = ["@earendil-works/*", "diff"];

const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));

/** Locate esbuild from the workspace root's .bin (not on PATH when invoked
 * directly with `node scripts/build.mjs`). */
function findEsbuild() {
  const candidates = [
    join(workspaceRoot, "node_modules", ".bin", "esbuild"),
    join(pkgRoot, "node_modules", ".bin", "esbuild"),
  ];
  for (const c of candidates) {
    try {
      execFileSync(c, ["--version"], { stdio: "ignore" });
      return c;
    } catch {
      // try next
    }
  }
  throw new Error("esbuild not found — run pnpm install at the workspace root first");
}

const ESBUILD = findEsbuild();

function run(cmd, args, opts) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}

console.log("[pi-c2 build] bundling index.ts -> dist/index.js");
rmSync(distDir, { recursive: true, force: true });
mkdirSync(join(distDir, "scripts"), { recursive: true });

const metaFile = join(distDir, "meta.json");
run(ESBUILD, [
  join(pkgRoot, "index.ts"),
  "--bundle",
  "--format=esm",
  "--platform=node",
  "--target=node22",
  // Prefer ESM builds over CJS/UMD so esbuild bundles cleanly (jsonc-parser
  // and friends ship both; the UMD build does dynamic requires esbuild cannot
  // inline).
  "--main-fields=module,main",
  `--outfile=${join(distDir, "index.js")}`,
  `--metafile=${metaFile}`,
  ...EXPLICIT_EXTERNAL.flatMap((e) => ["--external:" + e]),
]);

// Collect every external package the bundle references. These are real runtime
// deps of the published package (host SDKs, postinstall's diff, and the CJS
// packages the bundled code requires dynamically).
const meta = JSON.parse(readFileSync(metaFile, "utf8"));
const externalImports = new Set();
for (const input of Object.values(meta.inputs)) {
  for (const imp of input.imports ?? []) {
    if (imp.external && imp.path) externalImports.add(imp.path);
  }
}
const nodeBuiltins = new Set([
  "assert", "buffer", "child_process", "constants", "crypto", "diagnostics_channel", "events", "fs",
  "fs/promises", "http", "https", "module", "net", "os", "path", "punycode", "stream",
  "string_decoder", "tty", "url", "util", "worker_threads", "zlib",
]);
const externalPackages = [...externalImports]
  .filter((p) => !nodeBuiltins.has(p) && !p.startsWith("node:") && !p.startsWith(".") && !p.startsWith("/") && !p.startsWith("<"))
  .sort();

// Resolve the version of each external package from the workspace's pnpm store
// (prefer top-level .pnpm/<name>@<version>); fall back to "*" for packages
// that are truly missing from the store (optional/never-installed deps are
// skipped entirely — they are not needed at runtime).
function resolveVersion(name) {
  try {
    const scope = name.startsWith("@") ? name.split("/")[0] : "";
    const base = scope ? name.split("/")[1] : name;
    const store = join(workspaceRoot, "node_modules", ".pnpm");
    if (existsSync(store)) {
      const entries = readdirSync(store).filter((e) => e.startsWith(base + "@"));
      if (entries.length > 0) {
        const m = entries[0].match(/^[^@]+@(.+)$/);
        if (m) return "^" + m[1].split("_")[0];
      }
      // If the package is referenced but absent from the store, treat it as
      // an optional/never-installed dependency and skip it.
      return undefined;
    }
  } catch {
    // fall through
  }
  // Fall back to the workspace package.json if it is a known dep.
  for (const dep of [pkg.dependencies, pkg.devDependencies]) {
    if (dep?.[name]) return dep[name];
  }
  return undefined;
}
const externalDeps = {};
for (const name of externalPackages) {
  const version = resolveVersion(name);
  if (version) externalDeps[name] = version;
}

// Sanity checks: the bundle must have a default export, and must not reference
// any @xzy-ai/* package (they are all inlined).
const bundle = readFileSync(join(distDir, "index.js"), "utf8");
if (!/\bexport\s+default\b|\bas\s+default\b/.test(bundle)) {
  throw new Error("bundle is missing a default export — pi cannot load it");
}
for (const name of Object.keys(pkg.dependencies).filter((d) => d.startsWith("@xzy-ai/"))) {
  if (bundle.includes(`from "${name}"`) || bundle.includes(`require*("${name}")`)) {
    throw new Error(`bundle still imports ${name} — it must be inlined`);
  }
}

// Publish-ready manifest: point pi at the bundled file, keep the host SDK +
// postinstall + external CJS deps as runtime deps, move the inlined workspace
// packages to devDependencies (build-time only). The `pi` manifest field is
// preserved — the host loader uses it to discover the extension entry point.
const publishPkg = {
  ...pkg,
  main: "./index.js",
  types: undefined,
  files: ["index.js", "scripts/"],
  pi: { extensions: ["./index.js"] },
  private: false,
  publishConfig: { access: "public" },
  dependencies: {
    "@earendil-works/pi-coding-agent": pkg.dependencies["@earendil-works/pi-coding-agent"],
    "@earendil-works/pi-tui": pkg.dependencies["@earendil-works/pi-tui"],
    diff: pkg.dependencies.diff,
    ...externalDeps,
  },
  devDependencies: Object.fromEntries(
    Object.entries(pkg.dependencies).filter(([name]) => name.startsWith("@xzy-ai/")),
  ),
};
writeFileSync(join(distDir, "package.json"), JSON.stringify(publishPkg, null, 2) + "\n");

// The postinstall ships as source (node scripts/postinstall.mjs) and needs the
// bundled patch next to it.
cpSync(join(here, "postinstall.mjs"), join(distDir, "scripts", "postinstall.mjs"));
cpSync(
  join(here, "pi-coding-agent@0.84.2.patch"),
  join(distDir, "scripts", "pi-coding-agent@0.84.2.patch"),
);

// Verify the bundle loads as a factory function through jiti — the same
// loader pi uses (jiti/static, default-export unwrap). The verify script is
// written into the SDK's own node_modules parent so `jiti` resolves exactly
// as the host would.
const sdkDir = join(workspaceRoot, "node_modules", ".pnpm");
const sdkEntry =
  readdirSync(sdkDir).find((e) => e.startsWith("@earendil-works+pi-coding-agent@0.84.2") && e.includes("patch_hash")) ??
  readdirSync(sdkDir).find((e) => e.startsWith("@earendil-works+pi-coding-agent@0.84.2"));
if (!sdkEntry) throw new Error("patched host SDK not found in pnpm store — run pnpm install first");
const sdkPkg = join(sdkDir, sdkEntry, "node_modules", "@earendil-works", "pi-coding-agent");
const verifyScript =
  `import { createJiti } from 'jiti/static';\n` +
  `const jiti = createJiti(import.meta.url, { moduleCache: false });\n` +
  `const factory = await jiti.import(${JSON.stringify("file://" + join(distDir, "index.js"))}, { default: true });\n` +
  `if (typeof factory !== 'function') throw new Error('bundle default export is not a factory function');\n` +
  `console.log('[pi-c2 build] jiti load OK: default export is a function');\n`;
const verifyFile = join(sdkPkg, ".pi-c2-verify.mjs");
writeFileSync(verifyFile, verifyScript);
try {
  const verifyOut = run("node", [verifyFile]);
  process.stdout.write(verifyOut);
} finally {
  rmSync(verifyFile, { force: true });
}

console.log("[pi-c2 build] external runtime deps: " + externalPackages.join(", "));
console.log("[pi-c2 build] done: " + distDir);
