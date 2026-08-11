import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  validateReferenceAlias,
  validateReferenceCatalog,
  validateReferenceEntry,
  type ReferenceSource,
} from "@xzy-ai/core";

export const REFERENCES_DIRECTORY = "pi-code";
export const REFERENCES_FILE_NAME = "references.json";
export const REFERENCES_FILE_MODE = 0o644;

export type ReferenceAvailability = "available" | "unavailable";

export interface ReferenceCatalogEntry {
  readonly name: string;
  readonly source: ReferenceSource;
  readonly path?: string;
  readonly description?: string;
  readonly hidden?: boolean;
  readonly status: ReferenceAvailability;
  readonly diagnostic?: string;
}

export interface ReferenceCatalogReadResult {
  readonly entries: readonly ReferenceCatalogEntry[];
  readonly diagnostics: readonly string[];
}

export type AtomicReferenceWrite = (filePath: string, content: string) => Promise<void>;

export interface ReferenceCatalogOptions {
  readonly agentDir?: string;
  readonly homeDir?: string;
  readonly atomicWrite?: AtomicReferenceWrite;
}

export interface ReferenceCatalog {
  readonly filePath: string;
  readonly read: () => Promise<ReferenceCatalogReadResult>;
  readonly save: (document: unknown) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>;
}

/** Derive the global references configuration from the active Pi agent directory. */
export function referenceConfigFile(agentDir = getAgentDir()): string {
  return join(agentDir, REFERENCES_DIRECTORY, REFERENCES_FILE_NAME);
}

/**
 * Create the runtime catalog boundary. Reads are deliberately fresh: no
 * process-global snapshot is retained, so setup and later consumers observe
 * the current global document without a restart.
 */
export function createReferenceCatalog(options: ReferenceCatalogOptions = {}): ReferenceCatalog {
  const agentDir = options.agentDir ?? getAgentDir();
  const homeDir = options.homeDir ?? homedir();
  const filePath = referenceConfigFile(agentDir);
  const atomicWrite = options.atomicWrite ?? writeReferenceJson;

  return {
    filePath,
    read: () => readReferenceCatalog(filePath, homeDir),
    save: async (document) => {
      const validated = validateReferenceCatalog(document);
      if (!validated.ok) return { ok: false, error: "Invalid references configuration" };
      try {
        await atomicWrite(filePath, serializeReferenceDocument(document));
        return { ok: true };
      } catch {
        return { ok: false, error: "Unable to save references configuration" };
      }
    },
  };
}

async function readReferenceCatalog(filePath: string, homeDir: string): Promise<ReferenceCatalogReadResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { entries: [], diagnostics: [] };
    return { entries: [], diagnostics: ["Unable to read references configuration"] };
  }

  let document: unknown;
  try {
    document = JSON.parse(raw) as unknown;
  } catch {
    return { entries: [], diagnostics: ["References configuration is not valid strict JSON"] };
  }
  if (!isRecord(document) || !isRecord(document.references) || Array.isArray(document.references)) {
    return { entries: [], diagnostics: ["References configuration must contain a references object map"] };
  }

  const entries: ReferenceCatalogEntry[] = [];
  const diagnostics: string[] = [];
  for (const name of Object.keys(document.references).sort()) {
    const alias = validateReferenceAlias(name);
    if (!alias.ok) {
      diagnostics.push("A references entry has an invalid alias");
      continue;
    }
    const source = validateReferenceEntry(name, document.references[name]);
    if (!source.ok) {
      diagnostics.push(`Reference '${name}' is invalid`);
      continue;
    }
    const resolved = await resolveCatalogEntry(name, source.value, homeDir);
    entries.push(resolved.entry);
    if (resolved.diagnostic) diagnostics.push(resolved.diagnostic);
  }
  return { entries, diagnostics };
}

async function resolveCatalogEntry(
  name: string,
  source: ReferenceSource,
  homeDir: string,
): Promise<{ readonly entry: ReferenceCatalogEntry; readonly diagnostic?: string }> {
  const metadata = referenceEntryMetadata(name, source);
  if (source.type === "git") {
    return {
      entry: {
        ...metadata,
        status: "unavailable",
        diagnostic: "Git reference is not materialized",
      },
      diagnostic: `Reference '${name}' is unavailable until Git materialization is configured`,
    };
  }

  const configuredPath = source.path.startsWith("~/") ? join(homeDir, source.path.slice(2)) : source.path;
  const absolutePath = isAbsolute(configuredPath) ? configuredPath : undefined;
  if (!absolutePath) {
    return {
      entry: { ...metadata, path: configuredPath, status: "unavailable", diagnostic: "Local path is not absolute" },
      diagnostic: `Reference '${name}' has an unavailable local path`,
    };
  }
  try {
    const canonicalPath = await realpath(absolutePath);
    const information = await stat(canonicalPath);
    if (!information.isDirectory()) throw new Error("not a directory");
    return { entry: { ...metadata, path: canonicalPath, status: "available" } };
  } catch {
    return {
      entry: { ...metadata, path: absolutePath, status: "unavailable", diagnostic: "Local directory is unavailable" },
      diagnostic: `Reference '${name}' has an unavailable local path`,
    };
  }
}

async function writeReferenceJson(filePath: string, content: string): Promise<void> {
  const directory = dirname(filePath);
  const temporaryPath = join(directory, `.${REFERENCES_FILE_NAME}.tmp-${process.pid}-${randomUUID()}`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: REFERENCES_FILE_MODE, flag: "wx" });
    await chmod(temporaryPath, REFERENCES_FILE_MODE);
    await rename(temporaryPath, filePath);
    await chmod(filePath, REFERENCES_FILE_MODE);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function referenceEntryMetadata(name: string, source: ReferenceSource): {
  readonly name: string;
  readonly source: ReferenceSource;
  readonly description?: string;
  readonly hidden?: boolean;
} {
  return {
    name,
    source,
    ...(source.description === undefined ? {} : { description: source.description }),
    ...(source.hidden === undefined ? {} : { hidden: source.hidden }),
  };
}

function serializeReferenceDocument(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
