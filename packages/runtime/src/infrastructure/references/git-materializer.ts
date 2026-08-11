/**
 * System-Git materialization for the references catalog.
 *
 * Mirrors the OpenCode repository-cache contract without Effect or a Git
 * library: a child-process adapter with safe argument boundaries, a
 * branch-isolated cache layout derived from the core cache path, crash-
 * recoverable per-checkout locking with heartbeat liveness and owner-token
 * release, and best-effort runtime degradation.
 */
import { execFile } from "node:child_process";
import { mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  cacheIdentity,
  cachePath,
  parseRepository,
  validateBranch,
  type RepositoryReference,
} from "@xzy-ai/core";

export type GitMaterializeStatus = "cached" | "cloned" | "refreshed";

export interface GitMaterializeResult {
  readonly localPath: string;
  readonly status: GitMaterializeStatus;
  readonly head?: string;
  readonly branch?: string;
}

export type GitCommandRunner = (
  args: readonly string[],
  cwd: string,
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

export interface GitMaterializerOptions {
  readonly timeoutMs?: number;
  readonly lockStaleMs?: number;
  readonly lockAcquireTimeoutMs?: number;
  readonly gitExecutable?: string;
  readonly run?: GitCommandRunner;
}

export interface GitMaterializer {
  readonly ensure: (input: {
    readonly reference: RepositoryReference;
    readonly cacheRoot: string;
    readonly branch?: string;
    readonly refresh?: boolean;
    readonly signal?: AbortSignal;
  }) => Promise<GitMaterializeResult>;
  readonly preflight: (input: {
    readonly reference: RepositoryReference;
    readonly branch?: string;
    readonly signal?: AbortSignal;
  }) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS = 30_000;

export function createGitMaterializer(options: GitMaterializerOptions = {}): GitMaterializer {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  const lockAcquireTimeoutMs = options.lockAcquireTimeoutMs ?? DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS;
  const run = options.run ?? ((args, cwd, opts) => runGitProcess(args, cwd, opts, options.gitExecutable));

  async function ensure(input: {
    readonly reference: RepositoryReference;
    readonly cacheRoot: string;
    readonly branch?: string;
    readonly refresh?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<GitMaterializeResult> {
    if (input.branch !== undefined) {
      const branchOk = validateBranch(input.branch);
      if (!branchOk.ok) throw new Error(branchOk.error);
    }
    const localPath = cachePath(input.cacheRoot, input.reference, input.branch);
    const token = lockToken();
    try {
      return await withLock(`${localPath}.lock`, lockStaleMs, token, lockAcquireTimeoutMs, async () => {
      await mkdir(dirname(localPath), { recursive: true });

      const existing = await discoverWorktree(localPath, run, timeoutMs, input.signal);
      const origin = existing ? await remoteOrigin(existing.path, run, timeoutMs, input.signal) : undefined;
      const actualBranch = existing ? await currentBranch(existing.path, run, timeoutMs, input.signal) : undefined;
      const originReference = origin ? parseRepository(stripGitCredentials(origin)) : undefined;
      const reuse = Boolean(
        existing &&
          existing.topLevel === existing.path &&
          originReference &&
          cacheIdentity(originReference) === cacheIdentity(input.reference) &&
          (input.branch === undefined || actualBranch === input.branch),
      );

      if (!reuse) {
        await rm(localPath, { recursive: true, force: true });
      }

      const status: GitMaterializeStatus = !reuse ? "cloned" : input.refresh ? "refreshed" : "cached";

      if (status === "cloned") {
        await clone(input.reference, localPath, input.branch, run, timeoutMs, input.signal);
      } else if (status === "refreshed") {
        await refresh(localPath, input.reference, input.branch, run, timeoutMs, input.signal);
      }

      const [head, branch] = await Promise.all([
        headAt(localPath, run, timeoutMs, input.signal),
        currentBranch(localPath, run, timeoutMs, input.signal),
      ]);
        return { localPath, status, head, branch };
      });
    } catch (error) {
      throw new Error(sanitizeError(error), { cause: error });
    }
  }

  async function preflight(input: {
    readonly reference: RepositoryReference;
    readonly branch?: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
    if (input.branch !== undefined) {
      const branchOk = validateBranch(input.branch);
      if (!branchOk.ok) return { ok: false, error: branchOk.error };
    }
    try {
      const args = ["git", "ls-remote", input.reference.remote];
      if (input.branch) args.push(`refs/heads/${input.branch}`);
      const result = await run(args, process.cwd(), { timeoutMs, signal: input.signal });
      if (input.branch && !result.stdout.includes(`refs/heads/${input.branch}`)) {
        return { ok: false, error: "Repository branch is not available" };
      }
      return { ok: true };
    } catch {
      return { ok: false, error: "Repository is unavailable" };
    }
  }

  return { ensure, preflight };
}

async function clone(
  reference: RepositoryReference,
  localPath: string,
  branch: string | undefined,
  run: GitCommandRunner,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const args = ["git", "clone", "--no-tags"];
  if (branch) args.push("--branch", branch, "--single-branch");
  args.push(reference.remote, localPath);
  await run(args, dirname(localPath), { timeoutMs, signal });
}

async function refresh(
  localPath: string,
  reference: RepositoryReference,
  branch: string | undefined,
  run: GitCommandRunner,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  await run(["git", "-C", localPath, "fetch", "--prune", "--no-tags", "origin"], localPath, { timeoutMs, signal });
  const target = branch ?? (await defaultRemoteBranch(localPath, run, timeoutMs, signal));
  if (target) {
    await run(["git", "-C", localPath, "checkout", target], localPath, { timeoutMs, signal });
    await run(["git", "-C", localPath, "reset", "--hard", `origin/${target}`], localPath, { timeoutMs, signal });
  }
}

async function defaultRemoteBranch(
  localPath: string,
  run: GitCommandRunner,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  try {
    const result = await run(["git", "-C", localPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], localPath, {
      timeoutMs,
      signal,
    });
    return (result.stdout.trim() || undefined)?.replace(/^origin\//, "");
  } catch {
    return undefined;
  }
}

async function discoverWorktree(
  localPath: string,
  run: GitCommandRunner,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ readonly path: string; readonly topLevel: string } | undefined> {
  try {
    const topLevel = await run(["git", "-C", localPath, "rev-parse", "--show-toplevel"], localPath, { timeoutMs, signal });
    const resolved = await realpath(localPath);
    return { path: resolved, topLevel: topLevel.stdout.trim() };
  } catch {
    return undefined;
  }
}

async function remoteOrigin(localPath: string, run: GitCommandRunner, timeoutMs: number, signal: AbortSignal | undefined): Promise<string | undefined> {
  try {
    const result = await run(["git", "-C", localPath, "config", "--get", "remote.origin.url"], localPath, { timeoutMs, signal });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function headAt(localPath: string, run: GitCommandRunner, timeoutMs: number, signal: AbortSignal | undefined): Promise<string | undefined> {
  try {
    const result = await run(["git", "-C", localPath, "rev-parse", "HEAD"], localPath, { timeoutMs, signal });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function currentBranch(localPath: string, run: GitCommandRunner, timeoutMs: number, signal: AbortSignal | undefined): Promise<string | undefined> {
  try {
    const result = await run(["git", "-C", localPath, "rev-parse", "--abbrev-ref", "HEAD"], localPath, { timeoutMs, signal });
    const value = result.stdout.trim();
    return value === "HEAD" ? undefined : value;
  } catch {
    return undefined;
  }
}

async function withLock<T>(
  lockPath: string,
  staleMs: number,
  token: string,
  acquireTimeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  await acquireLock(lockPath, staleMs, token, acquireTimeoutMs);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    heartbeat = setInterval(() => {
      writeFile(`${lockPath}/heartbeat`, String(Date.now()), "utf8").catch(() => undefined);
    }, Math.max(1, Math.floor(staleMs / 3)));
    heartbeat.unref();
    return await operation();
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await releaseLock(lockPath, token);
  }
}

async function acquireLock(
  lockPath: string,
  staleMs: number,
  token: string,
  acquireTimeoutMs: number,
): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + acquireTimeoutMs;
  for (;;) {
    try {
      await mkdir(lockPath);
      await writeFile(`${lockPath}/owner`, token, "utf8");
      await writeFile(`${lockPath}/heartbeat`, String(Date.now()), "utf8");
      return;
    } catch (error) {
      if (!isErrno(error) || error.code !== "EEXIST") throw error;
      if (await isLockStale(lockPath, staleMs)) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error("Timed out acquiring the repository cache lock");
      await sleep(50);
    }
  }
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    const owner = await stat(lockPath);
    if (owner.isDirectory()) {
      const recorded = await readOwner(lockPath);
      if (recorded === token) {
        await rm(lockPath, { recursive: true, force: true });
      }
    }
  } catch {
    // Lock already removed or being replaced; nothing to release.
  }
}

async function readOwner(lockPath: string): Promise<string | undefined> {
  try {
    const { readFile } = await import("node:fs/promises");
    return (await readFile(`${lockPath}/owner`, "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function isLockStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const dirInfo = await stat(lockPath);
    const ownerInfo = await stat(`${lockPath}/heartbeat`).catch(() => undefined);
    const reference = ownerInfo ? ownerInfo.mtimeMs : dirInfo.mtimeMs;
    return Date.now() - reference > staleMs;
  } catch {
    return false;
  }
}

function lockToken(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function runGitProcess(
  args: readonly string[],
  cwd: string,
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
  gitExecutable = "git",
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      gitExecutable,
      args.slice(1),
      { cwd, timeout: options.timeoutMs, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const exitCode = typeof (error as { code?: unknown }).code === "number" ? (error as { code?: number }).code : undefined;
          reject(
            Object.assign(new Error(sanitizeOutput(stderr) || "Git command failed"), {
              gitExitCode: exitCode,
              code: (error as { code?: unknown }).code,
            }),
          );
          return;
        }
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
    if (options.signal) {
      if (options.signal.aborted) child.kill();
      else options.signal.addEventListener("abort", () => child.kill(), { once: true });
    }
  });
}

function sanitizeOutput(value: string): string {
  const sanitized = value.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/g, "$1<redacted>@");
  const message = sanitized.trim().slice(0, 500);
  return message.length > 0 ? message : "Git command failed";
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeOutput(message);
}

function stripGitCredentials(remote: string): string {
  try {
    const url = new URL(remote);
    if (url.username) url.username = "";
    if (url.password) url.password = "";
    return url.toString();
  } catch {
    return remote;
  }
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}