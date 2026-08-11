/**
 * Pure Git repository parsing and cache identity derivation.
 *
 * Mirrors the OpenCode repository contract without external dependencies or
 * filesystem/network effects. Produces a normalized repository reference from
 * GitHub-style shorthand, host/path strings, scp-style remotes, and `file://`
 * URLs for deterministic local test fixtures.
 */
import { fileURLToPath } from "node:url";

export type RepositoryReference =
  | {
      readonly protocol: "file:";
      readonly host: "file";
      readonly path: string;
      readonly segments: string[];
      readonly remote: string;
      readonly label: string;
    }
  | {
      readonly protocol: "https:" | "git:" | "http:" | "ssh:" | undefined;
      readonly host: string;
      readonly path: string;
      readonly segments: string[];
      readonly remote: string;
      readonly label: string;
    };

export type ParseRepositoryError = { readonly ok: false; readonly error: string };

/**
 * Validate a raw repository string for safety: non-empty, no path-traversal
 * segments, and no characters that could break process argument boundaries.
 * Returns the trimmed value on success.
 */
export function validateRepository(
  repo: string,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string } {
  if (repo.trim().length === 0) return { ok: false, error: "repository must not be empty" };
  if (/[\s\\;`$]/.test(repo)) {
    return { ok: false, error: "repository must not contain whitespace or shell metacharacters" };
  }
  const segments = repo.split(/[/\\]+/);
  if (segments.some((s) => s === ".." || s === ".")) {
    return { ok: false, error: "repository must not contain path-traversal segments" };
  }
  return { ok: true, value: repo.trim() };
}

function parts(input: string): string[] {
  return input
    .split("/")
    .map((item) => item.replace(/\.git$/, "").trim())
    .filter(Boolean);
}

function safeSegment(segment: string): boolean {
  return segment !== "." && segment !== ".." && !segment.includes(":") && !/[\s/\\]/.test(segment);
}

function safeHost(host: string): boolean {
  return host.length > 0 && !host.startsWith("-") && !/[\s/\\]/.test(host);
}

function trimInput(input: string): string {
  return input
    .trim()
    .replace(/^git\+/, "")
    .replace(/#.*$/, "")
    .replace(/\/+$/, "");
}

function buildRemote(input: {
  host: string;
  segments: string[];
  remote?: string;
  protocol?: "https:" | "git:" | "http:" | "ssh:" | undefined;
}): RepositoryReference | undefined {
  const segments = input.segments.map((s) => s.replace(/\.git$/, "")).filter(Boolean);
  if (!safeHost(input.host) || segments.length === 0 || segments.some((s) => !safeSegment(s))) return undefined;
  const host = input.host.toLowerCase();
  const repositoryPath = segments.join("/");
  return {
    host,
    path: repositoryPath,
    segments,
    remote: input.remote ?? (host === "github.com" ? `https://github.com/${repositoryPath}.git` : `https://${host}/${repositoryPath}.git`),
    label: host === "github.com" && segments.length === 2 ? repositoryPath : `${host}/${repositoryPath}`,
    protocol: input.protocol,
  };
}

function buildFile(repositoryPath: string, remote: string): RepositoryReference {
  const segments = repositoryPath.split(/[\\/]+/).filter(Boolean);
  return {
    protocol: "file:",
    host: "file",
    path: repositoryPath,
    segments,
    remote,
    label: repositoryPath,
  };
}

/**
 * Parse a repository reference from a shorthand, host/path, scp remote, or
 * `file://` URL. Returns `undefined` for inputs that are not a valid Git
 * reference shape.
 */
export function parseRepository(input: string): RepositoryReference | undefined {
  const cleaned = trimInput(input);
  if (!cleaned) return undefined;

  const githubPrefixed = cleaned.match(/^github:([^/\s]+)\/([^/\s]+)$/);
  if (githubPrefixed) return buildRemote({ host: "github.com", segments: [githubPrefixed[1]!, githubPrefixed[2]!] });

  if (!cleaned.includes("://")) {
    const scp = cleaned.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
    if (scp) return buildRemote({ host: scp[1]!, segments: parts(scp[2]!), remote: cleaned });

    const direct = parts(cleaned);
    if (direct.length >= 2 && hostLike(direct[0]!)) return buildRemote({ host: direct[0]!, segments: direct.slice(1) });
    if (direct.length === 2) return buildRemote({ host: "github.com", segments: direct });
  }

  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    return undefined;
  }
  if (url.protocol === "file:") {
    try {
      const repoPath = fileURLToPath(url);
      if (!repoPath) return undefined;
      return buildFile(repoPath, cleaned);
    } catch {
      return undefined;
    }
  }
  const segments = parts(url.pathname);
  return buildRemote({
    host: url.host,
    segments,
    remote: url.host === "github.com" ? `https://github.com/${segments.join("/")}.git` : cleaned,
    protocol: url.protocol as "https:" | "git:" | "http:" | "ssh:",
  });
}

function hostLike(input: string): boolean {
  return input.includes(".") || input.includes(":") || input === "localhost";
}

/** Normalize a parsed repository into a canonical identity for cache isolation. */
export function cacheIdentity(reference: RepositoryReference): string {
  return `${reference.host}/${reference.path}`;
}

/** Derive a deterministic, branch-isolated cache directory for a repository. */
export function cachePath(root: string, reference: RepositoryReference, branch?: string): string {
  const base = `${root}/${reference.host}/${reference.path}`;
  return branch ? `${base}@${encodeURIComponent(branch)}` : base;
}