import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalProjectRoot } from "../../shared/paths.ts";
import { isWithinScope, isDescendantScope } from "./containment.ts";

export interface ResolvedTicketScope {
  readonly canonical: string;
}

export type ResolveTicketScopeError =
  | "empty"
  | "absolute"
  | "traversal"
  | "root"
  | "file"
  | "escape"
  | "outside";

export interface ResolveTicketScopesInput {
  readonly projectRoot: string;
  readonly directories: readonly string[];
  readonly exists?: (path: string) => boolean;
  readonly statIsDirectory?: (path: string) => boolean;
  readonly realpath?: (path: string) => string;
}

/**
 * Resolve project-relative directory inputs into canonical absolute scopes.
 * Rejects absolute paths, traversal, the project root itself, existing files,
 * symlink escapes, and any scope whose nearest existing ancestor is outside
 * the active project. Missing nested levels are allowed when their nearest
 * existing ancestor is canonically inside the project.
 */
export function resolveTicketScopes(input: ResolveTicketScopesInput): ResolvedTicketScope[] {
  const exists = input.exists ?? ((path: string) => existsSync(path));
  const statIsDirectory = input.statIsDirectory ?? ((path: string) => statSync(path).isDirectory());
  const realpath = input.realpath ?? ((path: string) => realpathSync(path));
  const projectRoot = canonicalProjectRoot(input.projectRoot);

  if (input.directories.length === 0) throw new Error("Directories must not be empty.");
  const scopes: string[] = [];
  for (const directory of input.directories) {
    if (typeof directory !== "string" || directory.length === 0) throw new Error("Directory must not be empty.");
    if (isAbsolute(directory)) throw new Error("Directory must be project-relative.");
    if (directory === ".") throw new Error("Directory must be a subdirectory, not the project root.");
    const segments = directory.split(/[\\/]/);
    if (segments.includes("..")) throw new Error(`Directory escapes the project: ${directory}`);
    const raw = join(projectRoot, directory);
    const resolved = resolve(raw);
    if (resolved !== raw) throw new Error(`Directory escapes the project: ${directory}`);
    let ancestor = resolved;
    while (!exists(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    let canonicalAncestor: string;
    try {
      if (!statIsDirectory(ancestor)) throw new Error(`Not a directory: ${directory}`);
      canonicalAncestor = realpath(ancestor);
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error(`Cannot resolve directory: ${directory}`);
    }
    const suffix = relative(ancestor, resolved);
    const canonical = resolve(canonicalAncestor, suffix);
    if (canonical === projectRoot) throw new Error("Directory must be a subdirectory, not the project root.");
    if (canonical === projectRoot || !isWithinProject(projectRoot, canonical)) {
      throw new Error(`Directory escapes the project: ${directory}`);
    }
    if (scopes.includes(canonical)) throw new Error(`Duplicate directory: ${directory}`);
    for (const existing of scopes) {
      if (isWithinScope(existing, canonical) || isWithinScope(canonical, existing)) {
        throw new Error(`Nested directory overlap: ${directory}`);
      }
    }
    scopes.push(canonical);
  }
  return scopes.map((canonical) => ({ canonical }));
}

function isWithinProject(projectRoot: string, path: string): boolean {
  return path === projectRoot || path.startsWith(projectRoot.endsWith("/") ? projectRoot : `${projectRoot}/`);
}

/** Re-export the shared containment predicates for the enforcement hook. */
export { isWithinScope as isCanonicalWithinScope, isDescendantScope } from "./containment.ts";
