import { type ReferenceCatalog, createReferenceCatalog } from "@xzy-ai/runtime";
import {
  parseRepository,
  validateBranch,
  validateReferenceAlias,
  validateLocalPath,
  validateRepository,
  type ReferenceCatalogDocument,
} from "@xzy-ai/core";

/** UI-agnostic boundary implemented by the commands package. */
export interface ReferencesSetupController {
  list(): Promise<{ items: readonly ReferencesSetupItem[] }>;
  addLocal(input: ReferencesLocalInput): Promise<ReferencesMutationResult>;
  updateLocal(alias: string, input: ReferencesLocalInput): Promise<ReferencesMutationResult>;
  addGit?(input: ReferencesGitInput): Promise<ReferencesMutationResult>;
  updateGit?(alias: string, input: ReferencesGitInput): Promise<ReferencesMutationResult>;
  testGit?(alias: string, signal?: AbortSignal): Promise<ReferencesOperationResult>;
  refreshGit?(alias: string, signal?: AbortSignal): Promise<ReferencesOperationResult>;
  remove(alias: string, signal?: AbortSignal): Promise<ReferencesMutationResult>;
  cancel(): Promise<void>;
}

export interface ReferencesSetupItem {
  readonly name: string;
  readonly label: string;
  /** Raw local details when the entry is a local reference (object or shorthand). */
  readonly local?: { path: string; description?: string; hidden?: boolean };
  readonly git?: { repository: string; branch?: string; description?: string; hidden?: boolean };
}

export interface ReferencesLocalInput {
  readonly alias?: string;
  readonly path: string;
  readonly description?: string;
  readonly hidden?: boolean;
  readonly signal?: AbortSignal;
}

export interface ReferencesGitInput {
  readonly alias?: string;
  readonly repository: string;
  readonly branch?: string;
  readonly description?: string;
  readonly hidden?: boolean;
  readonly signal?: AbortSignal;
}

export type ReferencesMutationResult = { readonly ok: true; readonly message: string } | { readonly ok: false; readonly message: string };
export type ReferencesOperationResult =
  | { readonly ok: true; readonly message: string; readonly materialization?: string; readonly branch?: string; readonly head?: string }
  | { readonly ok: false; readonly message: string };

export interface ReferencesSetupControllerOptions {
  readonly catalog?: ReferenceCatalog;
  readonly catalogFactory?: () => ReferenceCatalog;
  readonly itemsFrom?: (document: ReferenceCatalogDocument) => ReferencesSetupItem[];
}

function safeDocument(document: unknown): ReferenceCatalogDocument {
  const candidate = document as ReferenceCatalogDocument;
  if (typeof candidate !== "object" || candidate === null) return { references: {} };
  return { references: { ...candidate.references } };
}

export function createReferencesSetupController(
  options: ReferencesSetupControllerOptions = {},
): ReferencesSetupController {
  const catalog = options.catalog ?? (options.catalogFactory ?? (() => createReferenceCatalog()))();
  let cancelled = false;
  const itemsFrom = options.itemsFrom ?? ((document: ReferenceCatalogDocument) =>
    Object.entries(document.references).map(([name, entry]) => {
      if (typeof entry === "string") {
        if (validateLocalPath(entry).ok) return { name, label: entry, local: { path: entry } };
        return parseRepository(entry) ? { name, label: entry, git: { repository: entry } } : { name, label: entry };
      }
      if (entry && typeof entry === "object" && "path" in entry) {
        const raw = entry as { path: unknown; description?: unknown; hidden?: unknown };
        const local: { path: string; description?: string; hidden?: boolean } = { path: String(raw.path) };
        if (raw.description !== undefined) local.description = String(raw.description);
        if (raw.hidden !== undefined) local.hidden = Boolean(raw.hidden);
        return { name, label: local.path, local };
      }
      if (entry && typeof entry === "object" && "repository" in entry) {
        const raw = entry as { repository: unknown; branch?: unknown; description?: unknown; hidden?: unknown };
        const git: { repository: string; branch?: string; description?: string; hidden?: boolean } = { repository: String(raw.repository) };
        if (raw.branch !== undefined) git.branch = String(raw.branch);
        if (raw.description !== undefined) git.description = String(raw.description);
        if (raw.hidden !== undefined) git.hidden = Boolean(raw.hidden);
        return { name, label: git.repository, git };
      }
      return { name, label: name };
    }));

  async function load(): Promise<ReferenceCatalogDocument> {
    cancelled = false;
    return safeDocument(await catalog.readDocument());
  }

  async function persist(document: ReferenceCatalogDocument, signal?: AbortSignal): Promise<ReferencesMutationResult> {
    const preflight = await catalog.preflight(document, { signal });
    if (!preflight.ok) return { ok: false, message: "Validation failed before saving" };
    if (cancelled || signal?.aborted) return { ok: false, message: "References setup was cancelled" };
    const saved = await catalog.save(document, { signal });
    if (!saved.ok) return { ok: false, message: "Unable to save references configuration" };
    return { ok: true, message: "Reference saved." };
  }

  return {
    async list() {
      const document = await load();
      return { items: itemsFrom(document) };
    },
    async addLocal(input) {
      const document = await load();
      const alias = input.alias ?? "";
      const aliasOk = validateReferenceAlias(alias);
      if (!aliasOk.ok) return { ok: false, message: aliasOk.error };
      const pathOk = validateLocalPath(input.path);
      if (!pathOk.ok) return { ok: false, message: pathOk.error };
      if (alias in document.references) return { ok: false, message: "A reference with this alias already exists" };
      const local: { path: string; description?: string; hidden?: boolean } = { path: input.path };
      if (input.description !== undefined) local.description = input.description;
      if (input.hidden !== undefined) local.hidden = input.hidden;
      return persist({ ...document, references: { ...document.references, [alias]: local } }, input.signal);
    },
    async addGit(input) {
      const document = await load();
      const alias = input.alias ?? "";
      const aliasOk = validateReferenceAlias(alias);
      if (!aliasOk.ok) return { ok: false, message: aliasOk.error };
      const repositoryOk = validateRepository(input.repository);
      if (!repositoryOk.ok || !parseRepository(input.repository)) return { ok: false, message: repositoryOk.ok ? "Invalid Git repository" : repositoryOk.error };
      if (input.branch !== undefined) {
        const branchOk = validateBranch(input.branch);
        if (!branchOk.ok) return { ok: false, message: branchOk.error };
      }
      if (alias in document.references) return { ok: false, message: "A reference with this alias already exists" };
      const git: { repository: string; branch?: string; description?: string; hidden?: boolean } = { repository: input.repository };
      if (input.branch !== undefined) git.branch = input.branch;
      if (input.description !== undefined) git.description = input.description;
      if (input.hidden !== undefined) git.hidden = input.hidden;
      return persist({ ...document, references: { ...document.references, [alias]: git } }, input.signal);
    },
    async updateGit(alias, input) {
      const document = await load();
      const existing = document.references[alias];
      if (existing === undefined) return { ok: false, message: "Reference not found" };
      const repositoryOk = validateRepository(input.repository);
      if (!repositoryOk.ok || !parseRepository(input.repository)) return { ok: false, message: repositoryOk.ok ? "Invalid Git repository" : repositoryOk.error };
      if (input.branch !== undefined) {
        const branchOk = validateBranch(input.branch);
        if (!branchOk.ok) return { ok: false, message: branchOk.error };
      }
      const rawExisting = typeof existing === "string" ? { repository: existing } : existing && typeof existing === "object" && "repository" in existing ? existing as Record<string, unknown> : undefined;
      if (!rawExisting) return { ok: false, message: "Only Git references can be edited here" };
      if (typeof existing === "string" && input.branch === undefined && input.description === undefined && input.hidden === undefined) {
        return persist({ ...document, references: { ...document.references, [alias]: input.repository } }, input.signal);
      }
      const git: Record<string, unknown> = { ...rawExisting, repository: input.repository };
      if (input.branch === "") delete git.branch;
      else if (input.branch !== undefined) git.branch = input.branch;
      if (input.description !== undefined) git.description = input.description;
      if (input.hidden !== undefined) git.hidden = input.hidden;
      return persist({ ...document, references: { ...document.references, [alias]: git as ReferenceCatalogDocument["references"][string] } }, input.signal);
    },
    async testGit(alias, signal) {
      return operateGit(alias, false, signal);
    },
    async refreshGit(alias, signal) {
      return operateGit(alias, true, signal);
    },
    async updateLocal(alias, input) {
      const document = await load();
      const pathOk = validateLocalPath(input.path);
      if (!pathOk.ok) return { ok: false, message: pathOk.error };
      const existing = document.references[alias];
      if (existing === undefined) return { ok: false, message: "Reference not found" };
      let next: unknown;
      if (typeof existing === "string") {
        if (input.description === undefined && input.hidden === undefined) {
          next = input.path; // keep shorthand form
        } else {
          const local: { path: string; description?: string; hidden?: boolean } = { path: input.path };
          if (input.description !== undefined) local.description = input.description;
          if (input.hidden !== undefined) local.hidden = input.hidden;
          next = local;
        }
      } else if (existing && typeof existing === "object" && !("repository" in existing)) {
        const raw = existing as Record<string, unknown>;
        const local: Record<string, unknown> = { ...raw, path: input.path };
        if (input.description !== undefined) local.description = input.description;
        if (input.hidden !== undefined) local.hidden = input.hidden;
        next = local;
      } else {
        return { ok: false, message: "Only local references can be edited here" };
      }
      return persist({
        ...document,
        references: {
          ...document.references,
          [alias]: next as ReferenceCatalogDocument["references"][string],
        },
      }, input.signal);
    },
    async remove(alias, signal) {
      const document = await load();
      if (!(alias in document.references)) return { ok: false, message: "Reference not found" };
      const references = { ...document.references };
      delete references[alias];
      const result = await persist({ ...document, references }, signal);
      return result.ok ? { ok: true, message: "Reference removed." } : result;
    },
    async cancel() {
      cancelled = true;
    },
  };

  async function operateGit(alias: string, refresh: boolean, signal?: AbortSignal): Promise<ReferencesOperationResult> {
    const document = await load();
    const raw = document.references[alias];
    const git = typeof raw === "string" ? { repository: raw } : raw && typeof raw === "object" && "repository" in raw ? raw as { repository: string; branch?: string } : undefined;
    if (!git) return { ok: false, message: "Only Git references can be tested or refreshed" };
    const input = { repository: git.repository, ...(git.branch === undefined ? {} : { branch: git.branch }) };
    const operation = refresh ? await catalog.refreshReference(input, { signal }) : await catalog.testReference(input, { signal });
    if (!operation.ok) return { ok: false, message: operation.error };
    const details = [operation.entry.materialization, operation.entry.branch ? `branch ${operation.entry.branch}` : undefined, operation.entry.head ? `head ${operation.entry.head}` : undefined].filter(Boolean).join(", ");
    return { ok: true, message: refresh ? `Reference refreshed${details ? ` (${details})` : ""}.` : `Reference available${details ? ` (${details})` : ""}.`, materialization: operation.entry.materialization, branch: operation.entry.branch, head: operation.entry.head };
  }
}
