import { type ReferenceCatalog, createReferenceCatalog } from "@xzy-ai/runtime";
import { validateReferenceAlias, validateLocalPath, type ReferenceCatalogDocument } from "@xzy-ai/core";

/** UI-agnostic boundary implemented by the commands package. */
export interface ReferencesSetupController {
  list(): Promise<{ items: readonly ReferencesSetupItem[] }>;
  addLocal(input: ReferencesLocalInput): Promise<ReferencesMutationResult>;
  updateLocal(alias: string, input: ReferencesLocalInput): Promise<ReferencesMutationResult>;
  remove(alias: string, signal?: AbortSignal): Promise<ReferencesMutationResult>;
  cancel(): Promise<void>;
}

export interface ReferencesSetupItem {
  readonly name: string;
  readonly label: string;
  /** Raw local details when the entry is a local reference (object or shorthand). */
  readonly local?: { path: string; description?: string; hidden?: boolean };
}

export interface ReferencesLocalInput {
  readonly alias?: string;
  readonly path: string;
  readonly description?: string;
  readonly hidden?: boolean;
  readonly signal?: AbortSignal;
}

export type ReferencesMutationResult = { readonly ok: true; readonly message: string } | { readonly ok: false; readonly message: string };

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
        return validateLocalPath(entry).ok
          ? { name, label: entry, local: { path: entry } }
          : { name, label: entry };
      }
      if (entry && typeof entry === "object" && "path" in entry) {
        const raw = entry as { path: unknown; description?: unknown; hidden?: unknown };
        const local: { path: string; description?: string; hidden?: boolean } = { path: String(raw.path) };
        if (raw.description !== undefined) local.description = String(raw.description);
        if (raw.hidden !== undefined) local.hidden = Boolean(raw.hidden);
        return { name, label: local.path, local };
      }
      return { name, label: entry && typeof entry === "object" && "repository" in entry ? String((entry as { repository: unknown }).repository) : name };
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
}
