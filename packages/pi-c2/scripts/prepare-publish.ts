import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGE_NAME = "@xzy-ai/pi-c2";
const NUMERIC_IDENTIFIER = "(?:0|[1-9]\\d*)";
const NON_NUMERIC_IDENTIFIER = "(?:\\d*[A-Za-z-][0-9A-Za-z-]*)";
const IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|${NON_NUMERIC_IDENTIFIER})`;
const RELEASE_VERSION_PATTERN = new RegExp(
  `^${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}` +
    `(?:-(?:${IDENTIFIER})(?:\\.${IDENTIFIER})*)?$`,
);

export interface PublishManifest {
  name: string;
  version: string;
  private?: boolean;
  [key: string]: unknown;
}

/** Validate an exact npm-compatible SemVer tag without normalization. */
export function validateReleaseVersion(version: string): string {
  if (!RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error(`Git tag must be a valid semver release tag without normalization: ${version}`);
  }
  return version;
}

/** Stamp the validated Git tag into the build's publish-ready manifest. */
export function preparePublishManifest(distDir: string, version: string): PublishManifest {
  validateReleaseVersion(version);
  const manifestPath = join(distDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PublishManifest;
  if (manifest.name !== PACKAGE_NAME) {
    throw new Error(`Unexpected publish package: ${manifest.name ?? "missing name"}`);
  }
  if (manifest.private === true) {
    throw new Error("Publish manifest must not be private");
  }
  manifest.version = version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

function argumentValue(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`Missing required argument: ${name}`);
  return value;
}

if (process.argv[1]?.endsWith("prepare-publish.ts")) {
  const manifest = preparePublishManifest(argumentValue("--dist"), argumentValue("--version"));
  console.log(`Prepared ${manifest.name}@${manifest.version} for npm publication`);
}
