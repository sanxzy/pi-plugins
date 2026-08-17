/**
 * Canonical path-containment helpers shared by ticket creation and the
 * write/edit enforcement hook. All comparisons use exact-or-descendant path
 * matching with path boundaries so `/src` never matches `/src-backup`.
 */

/** True when `candidate` equals `scope` or is a true descendant of it. */
export function isWithinScope(scope: string, candidate: string): boolean {
  if (scope === candidate) return true;
  const prefix = scope.endsWith("/") ? scope : `${scope}/`;
  return candidate.startsWith(prefix);
}

/**
 * True when `candidate` is a descendant (strictly beneath) `scope`, never the
 * scope itself.
 */
export function isDescendantScope(scope: string, candidate: string): boolean {
  const prefix = scope.endsWith("/") ? scope : `${scope}/`;
  return candidate.startsWith(prefix);
}
