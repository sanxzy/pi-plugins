/**
 * Pure reference-source contracts and validation for the references catalog.
 *
 * This module is dependency-free and mirrors the OpenCode reference schema and
 * repository semantics. It defines the discriminated union of local and Git
 * sources, the alias grammar, the strict JSON document shape, and the
 * deterministic branch-isolated cache identity used by materialization.
 */
import { parseRepository, validateRepository } from "./repository.ts";

/** A Git repository entry, compatible with OpenCode's `ConfigReference.Git`. */
export type GitReferenceEntry = {
  readonly repository: string;
  readonly branch?: string;
  readonly description?: string;
  readonly hidden?: boolean;
};

/** A local-directory entry, compatible with OpenCode's `ConfigReference.Local`. */
export type LocalReferenceEntry = {
  readonly path: string;
  readonly description?: string;
  readonly hidden?: boolean;
};

/** The union of valid reference entries: a shorthand string or an object. */
export type ReferenceEntry = string | LocalReferenceEntry | GitReferenceEntry;

/** The normalized strict JSON document shape. */
export type ReferenceCatalogDocument = {
  readonly references: Readonly<Record<string, ReferenceEntry>>;
};

/**
 * A validated source after entry normalization. A local source carries its
 * path (absolute or `~`-relative); a Git source carries its repository value
 * and optional branch. Description and hidden metadata are preserved.
 */
export type ReferenceSource =
  | {
      readonly type: "local";
      readonly path: string;
      readonly description?: string;
      readonly hidden?: boolean;
    }
  | {
      readonly type: "git";
      readonly repository: string;
      readonly branch?: string;
      readonly description?: string;
      readonly hidden?: boolean;
    };

export type ReferenceCatalog = {
  readonly references: Readonly<Record<string, ReferenceSource>>;
};

export type ValidationOk<T> = { readonly ok: true; readonly value: T };
export type ValidationError = { readonly ok: false; readonly error: string };
export type ValidationResult<T> = ValidationOk<T> | ValidationError;

/** Alias shorthand must be a non-empty token free of path separators and spaces. */
export function validateReferenceAlias(alias: string): ValidationResult<string> {
  if (alias.length === 0) return { ok: false, error: "alias must not be empty" };
  if (/[\/\\\s`,]/.test(alias)) {
    return { ok: false, error: "alias must not contain path separators, spaces, commas, or backticks" };
  }
  return { ok: true, value: alias };
}

/**
 * A local path is either absolute or home-relative (`~/...`). Other relative
 * values are rejected because the global document has no project base.
 */
export function validateLocalPath(path: string): ValidationResult<string> {
  if (path.startsWith("~/") || path.startsWith("/")) return { ok: true, value: path };
  return { ok: false, error: "local path must be an absolute path or begin with ~/" };
}

/** A branch is alphanumeric plus `/`, `_`, `.`, `-`, not starting with `-`, no `..`. */
export function validateBranch(branch: string): ValidationResult<string> {
  if (branch.length === 0) return { ok: false, error: "branch must not be empty" };
  if (/^[A-Za-z0-9/_.-]+$/.test(branch) && !branch.startsWith("-") && !branch.includes("..")) {
    return { ok: true, value: branch };
  }
  return { ok: false, error: "branch must contain only alphanumerics, /, _, ., - and not start with - or contain .." };
}

/** An object entry must be a plain local or Git source, never both. */
function validateEntryObject(entry: LocalReferenceEntry | GitReferenceEntry): ValidationResult<ReferenceSource> {
  if (typeof entry !== "object" || entry === null) {
    return { ok: false, error: "reference entry must be a string or object" };
  }
  const hasPath = "path" in entry && typeof entry.path === "string";
  const hasRepository = "repository" in entry && typeof entry.repository === "string";
  if (hasPath === hasRepository) {
    return { ok: false, error: "a reference must specify exactly one of path or repository" };
  }
  if (hasPath) {
    const path = validateLocalPath(entry.path);
    if (!path.ok) return path;
    return {
      ok: true,
      value: {
        type: "local",
        path: path.value,
        ...(entry.description === undefined ? {} : { description: entry.description }),
        ...(entry.hidden === undefined ? {} : { hidden: entry.hidden }),
      },
    };
  }
  if (!("repository" in entry)) return { ok: false, error: "reference repository must be a string" };
  const repository = validateRepository(entry.repository);
  if (!repository.ok) return repository;
  if (!parseRepository(repository.value)) return { ok: false, error: "repository is not a valid Git reference" };
  const branch = entry.branch === undefined ? undefined : validateBranch(entry.branch);
  if (branch !== undefined && !branch.ok) return branch;
  return {
    ok: true,
    value: {
      type: "git",
      repository: repository.value,
      ...(branch === undefined ? {} : { branch: branch.value }),
      ...(entry.description === undefined ? {} : { description: entry.description }),
      ...(entry.hidden === undefined ? {} : { hidden: entry.hidden }),
    },
  };
}

/**
 * Normalize a raw reference entry into a validated source. A string shorthand
 * is local when it begins with `/` or `~/`, otherwise it is a Git reference.
 */
export function validateReferenceEntry(alias: string, entry: unknown): ValidationResult<ReferenceSource> {
  const aliasOk = validateReferenceAlias(alias);
  if (!aliasOk.ok) return aliasOk;
  if (typeof entry === "string") {
    if (entry.startsWith("~") || entry.startsWith(".") || entry.startsWith("/")) {
      const path = validateLocalPath(entry);
      if (!path.ok) return path;
      return { ok: true, value: { type: "local", path: path.value } };
    }
    const repository = validateRepository(entry);
    if (!repository.ok) return repository;
    if (!parseRepository(repository.value)) return { ok: false, error: "repository is not a valid Git reference" };
    return { ok: true, value: { type: "git", repository: repository.value } };
  }
  if (typeof entry !== "object" || entry === null) {
    return { ok: false, error: "reference entry must be a string or object" };
  }
  const objectEntry = entry as LocalReferenceEntry | GitReferenceEntry;
  // Validate optional metadata surface before normalizing the source.
  if (
    objectEntry.description !== undefined &&
    (typeof objectEntry.description !== "string" || objectEntry.description.trim().length === 0)
  ) {
    return { ok: false, error: "description must be a non-empty string" };
  }
  if (objectEntry.hidden !== undefined && typeof objectEntry.hidden !== "boolean") {
    return { ok: false, error: "hidden must be a boolean" };
  }
  return validateEntryObject(objectEntry);
}

/** Validate a full strict JSON catalog document defensively. */
export function validateReferenceCatalog(
  doc: unknown,
): ValidationResult<{ readonly references: Readonly<Record<string, ReferenceSource>> }> {
  if (typeof doc !== "object" || doc === null) return { ok: false, error: "catalog document must be an object" };
  const refs = (doc as { references?: unknown }).references;
  if (typeof refs !== "object" || refs === null) return { ok: false, error: "references must be an object" };
  const out: Record<string, ReferenceSource> = {};
  const errors: string[] = [];
  for (const [alias, entry] of Object.entries(refs as Record<string, unknown>)) {
    const aliasOk = validateReferenceAlias(alias);
    if (!aliasOk.ok) {
      errors.push(`${alias}: ${aliasOk.error}`);
      continue;
    }
    const source = validateReferenceEntry(alias, entry);
    if (source.ok) out[alias] = source.value;
    else errors.push(`${alias}: ${source.error}`);
  }
  if (errors.length > 0) return { ok: false, error: errors.join("; ") };
  return { ok: true, value: { references: out } };
}