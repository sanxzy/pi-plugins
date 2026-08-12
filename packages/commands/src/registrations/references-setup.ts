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
    Object.entries(document.references).map(([name, entry]) => ({
      name,
      label: typeof entry === "string" ? entry : "repository" in entry ? String(entry.repository) : String(entry.path ?? ""),
    })));

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
      if (!(alias in document.references)) return { ok: false, message: "Reference not found" };
      const local: { path: string; description?: string; hidden?: boolean } = { path: input.path };
      if (input.description !== undefined) local.description = input.description;
      if (input.hidden !== undefined) local.hidden = input.hidden;
      return persist({ ...document, references: { ...document.references, [alias]: local } }, input.signal);
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
