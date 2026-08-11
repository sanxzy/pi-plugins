import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseRepository } from "@xzy-ai/core";
import { createGitMaterializer, type GitMaterializer } from "./git-materializer.ts";
import {
  validateReferenceAlias,
  validateReferenceCatalog,
  validateReferenceEntry,
  type ReferenceSource,
} from "@xzy-ai/core";

export const REFERENCES_DIRECTORY = "pi-code";
export const REFERENCES_FILE_NAME = "references.json";
export const REFERENCES_REPOS_DIRECTORY = "repos";
export const REFERENCES_FILE_MODE = 0o644;

export type ReferenceAvailability = "available" | "unavailable";

export interface ReferenceCatalogEntry {
  readonly name: string;
  readonly source: ReferenceSource;
  readonly path?: string;
  readonly description?: string;
  readonly hidden?: boolean;
  readonly branch?: string;
  readonly head?: string;
  readonly status: ReferenceAvailability;
  readonly diagnostic?: string;
}

export interface ReferenceCatalogReadResult {
  readonly entries: readonly ReferenceCatalogEntry[];
  readonly diagnostics: readonly string[];
}

export type AtomicReferenceWrite = (filePath: string, content: string) => Promise<void>;

export interface ReferenceFileSystem {
  readonly rename?: (source: string, destination: string) => Promise<void>;
}

export interface ReferenceCatalogOptions {
  readonly agentDir?: string;
  readonly homeDir?: string;
  readonly atomicWrite?: AtomicReferenceWrite;
  readonly fileSystem?: ReferenceFileSystem;
  readonly materializer?: GitMaterializer;
  readonly refresh?: boolean;
}

export interface ReferenceCatalog {
  readonly filePath: string;
  readonly reposDir: string;
  readonly read: () => Promise<ReferenceCatalogReadResult>;
  readonly save: (document: unknown) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>;
}

/** Derive the global references configuration from the active Pi agent directory. */
export function referenceConfigFile(agentDir = getAgentDir()): string {
  return join(agentDir, REFERENCES_DIRECTORY, REFERENCES_FILE_NAME);
}

/** Derive the global Git repository cache directory below the active Pi agent directory. */
export function referenceReposDir(agentDir = getAgentDir()): string {
  return join(agentDir, REFERENCES_DIRECTORY, REFERENCES_REPOS_DIRECTORY);
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
  const reposDir = referenceReposDir(agentDir);
  const atomicWrite = options.atomicWrite ?? ((path: string, content: string) =>
    writeReferenceJson(path, content, options.fileSystem));
  const materializer = options.materializer ?? createGitMaterializer();

  return {
    filePath,
    reposDir,
    read: () => readReferenceCatalog(filePath, homeDir, reposDir, options.refresh, materializer),
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

async function readReferenceCatalog(
  filePath: string,
  homeDir: string,
  reposDir: string,
  refresh: boolean | undefined,
  materializer: GitMaterializer,
): Promise<ReferenceCatalogReadResult> {
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
    const rawEntry = document.references[name];
    const source = validateReferenceEntry(name, rawEntry);
    const fallback = source.ok ? undefined : rejectedRelativeLocalSource(rawEntry);
    if (!source.ok && fallback === undefined) {
      diagnostics.push(`Reference '${name}' is invalid`);
      continue;
    }
    const resolved = await resolveCatalogEntry(name, source.ok ? source.value : fallback!, homeDir, reposDir, refresh, materializer);
    entries.push(resolved.entry);
    if (resolved.diagnostic) diagnostics.push(resolved.diagnostic);
  }
  return { entries, diagnostics };
}

async function resolveCatalogEntry(
  name: string,
  source: ReferenceSource,
  homeDir: string,
  reposDir: string,
  refresh: boolean | undefined,
  materializer: GitMaterializer,
): Promise<{ readonly entry: ReferenceCatalogEntry; readonly diagnostic?: string }> {
  const metadata = referenceEntryMetadata(name, source);
  if (source.type === "git") {
    const repository = parseRepository(source.repository);
    if (!repository) {
      return {
        entry: { ...metadata, status: "unavailable", diagnostic: "Git reference is invalid" },
        diagnostic: `Reference '${name}' is unavailable`,
      };
    }
    try {
      const result = await materializer.ensure({
        reference: repository,
        cacheRoot: reposDir,
        branch: source.branch,
        refresh,
      });
      return {
        entry: {
          ...metadata,
          path: result.localPath,
          status: "available",
          ...(result.head === undefined ? {} : { head: result.head }),
          ...(result.branch === undefined ? {} : { branch: result.branch }),
        },
      };
    } catch {
      return {
        entry: { ...metadata, status: "unavailable", diagnostic: "Git reference is unavailable" },
        diagnostic: `Reference '${name}' is unavailable`,
      };
    }
  }

  const isHomeRelative = source.path.startsWith("~/");
  const configuredPath = isHomeRelative ? join(homeDir, source.path.slice(2)) : source.path;
  const absolutePath = isAbsolute(configuredPath) ? configuredPath : undefined;
  if (!absolutePath) {
    return {
      entry: { ...metadata, path: source.path, status: "unavailable", diagnostic: "Local path is not absolute" },
      diagnostic: `Reference '${name}' has an unavailable local path`,
    };
  }
  if (isHomeRelative && !isWithin(homeDir, absolutePath)) {
    return {
      entry: { ...metadata, status: "unavailable", diagnostic: "Home-relative path escapes the configured home" },
      diagnostic: `Reference '${name}' has an unavailable local path`,
    };
  }
  try {
    let canonicalPath = await realpath(absolutePath);
    if (isHomeRelative) {
      const canonicalHome = await realpath(homeDir);
      if (!isWithin(canonicalHome, canonicalPath)) throw new Error("path escapes home");
    }
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

function isWithin(parent: string, child: string): boolean {
  const parentPath = resolve(parent);
  const childPath = resolve(child);
  const remainder = relative(parentPath, childPath);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${requirePathSeparator()}`) && !isAbsolute(remainder));
}

function requirePathSeparator(): string {
  return process.platform === "win32" ? "\\\\" : "/";
}

function rejectedRelativeLocalSource(rawEntry: unknown): ReferenceSource | undefined {
  if (typeof rawEntry === "string") {
    return rawEntry.startsWith(".") ? { type: "local", path: rawEntry } : undefined;
  }
  if (!isRecord(rawEntry) || typeof rawEntry.path !== "string" || Object.prototype.hasOwnProperty.call(rawEntry, "repository")) {
    return undefined;
  }
  if (rawEntry.description !== undefined && typeof rawEntry.description !== "string") return undefined;
  if (rawEntry.hidden !== undefined && typeof rawEntry.hidden !== "boolean") return undefined;
  return {
    type: "local",
    path: rawEntry.path,
    ...(rawEntry.description === undefined ? {} : { description: rawEntry.description }),
    ...(rawEntry.hidden === undefined ? {} : { hidden: rawEntry.hidden }),
  };
}

async function writeReferenceJson(filePath: string, content: string, fileSystem?: ReferenceFileSystem): Promise<void> {
  const directory = dirname(filePath);
  const temporaryPath = join(directory, `.${REFERENCES_FILE_NAME}.tmp-${process.pid}-${randomUUID()}`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: REFERENCES_FILE_MODE, flag: "wx" });
    await chmod(temporaryPath, REFERENCES_FILE_MODE);
    await (fileSystem?.rename ?? rename)(temporaryPath, filePath);
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
