export {
  validateBranch,
  validateLocalPath,
  validateReferenceAlias,
  validateReferenceCatalog,
  validateReferenceEntry,
  type GitReferenceEntry,
  type LocalReferenceEntry,
  type ReferenceCatalog,
  type ReferenceCatalogDocument,
  type ReferenceEntry,
  type ReferenceSource,
  type ValidationError,
  type ValidationOk,
  type ValidationResult,
} from "./source.ts";
export {
  cacheIdentity,
  cachePath,
  parseRepository,
  validateRepository,
  type ParseRepositoryError,
  type RepositoryReference,
} from "./repository.ts";
