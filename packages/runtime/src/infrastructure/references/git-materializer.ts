/**
 * System-Git materialization for the references catalog.
 *
 * Mirrors the OpenCode repository-cache contract without Effect or a Git
 * library: a child-process adapter with safe argument boundaries, a
 * branch-isolated cache layout derived from the core cache path, crash-
 * recoverable per-checkout locking, and best-effort runtime degradation.
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
  options: { readonly timeoutMs: number },
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

export interface GitMaterializerOptions {
  readonly timeoutMs?: number;
  readonly lockStaleMs?: number;
  readonly run?: GitCommandRunner;
}

export interface GitMaterializer {
  readonly ensure: (input: {
    readonly reference: RepositoryReference;
    readonly cacheRoot: string;
    readonly branch?: string;
    readonly refresh?: boolean;
  }) => Promise<GitMaterializeResult>;
  readonly preflight: (input: {
    readonly reference: RepositoryReference;
    readonly branch?: string;
  }) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const LOCK_WAIT_TIMEOUT_MS = 30_000;

export function createGitMaterializer(options: GitMaterializerOptions = {}): GitMaterializer {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  const run = options.run ?? runGitProcess;

  async function ensure(input: {
    readonly reference: RepositoryReference;
    readonly cacheRoot: string;
    readonly branch?: string;
    readonly refresh?: boolean;
  }): Promise<GitMaterializeResult> {
    if (input.branch !== undefined) {
      const branchOk = validateBranch(input.branch);
      if (!branchOk.ok) throw new Error(branchOk.error);
    }
    const localPath = cachePath(input.cacheRoot, input.reference, input.branch);
    return withLock(`${localPath}.lock`, lockStaleMs, async () => {
      await mkdir(dirname(localPath), { recursive: true });

      const existing = await discoverWorktree(localPath, run, timeoutMs);
      const origin = existing ? await remoteOrigin(existing.path, run, timeoutMs) : undefined;
      const originReference = origin ? parseRepository(stripGitCredentials(origin)) : undefined;
      const reuse = Boolean(
        existing &&
          existing.topLevel === existing.path &&
          originReference &&
          cacheIdentity(originReference) === cacheIdentity(input.reference),
      );

      if (!reuse) {
        await rm(localPath, { recursive: true, force: true });
      }

      const status: GitMaterializeStatus = !reuse ? "cloned" : input.refresh ? "refreshed" : "cached";

      if (status === "cloned") {
        await clone(input.reference, localPath, input.branch, run, timeoutMs);
      } else if (status === "refreshed") {
        await refresh(localPath, input.reference, input.branch, run, timeoutMs);
      }

      const [head, branch] = await Promise.all([
        headAt(localPath, run, timeoutMs),
        currentBranch(localPath, run, timeoutMs),
      ]);
      return { localPath, status, head, branch };
    });
  }

  async function preflight(input: {
    readonly reference: RepositoryReference;
    readonly branch?: string;
  }): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
    if (input.branch !== undefined) {
      const branchOk = validateBranch(input.branch);
      if (!branchOk.ok) return { ok: false, error: branchOk.error };
    }
    try {
      const args = ["git", "ls-remote", input.reference.remote];
      if (input.branch) args.push(`refs/heads/${input.branch}`);
      const result = await run(args, process.cwd(), { timeoutMs });
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
): Promise<void> {
  const args = ["git", "clone", "--no-tags"];
  if (branch) args.push("--branch", branch, "--single-branch");
  args.push(reference.remote, localPath);
  await run(args, dirname(localPath), { timeoutMs });
}

async function refresh(
  localPath: string,
  reference: RepositoryReference,
  branch: string | undefined,
  run: GitCommandRunner,
  timeoutMs: number,
): Promise<void> {
  await run(["git", "-C", localPath, "fetch", "--prune", "--no-tags", "origin"], localPath, { timeoutMs });
  const target = branch ?? (await defaultRemoteBranch(localPath, run, timeoutMs));
  if (target) {
    await run(["git", "-C", localPath, "checkout", target], localPath, { timeoutMs });
    await run(["git", "-C", localPath, "reset", "--hard", `origin/${target}`], localPath, { timeoutMs });
  }
}

async function defaultRemoteBranch(
  localPath: string,
  run: GitCommandRunner,
  timeoutMs: number,
): Promise<string | undefined> {
  try {
    const result = await run(["git", "-C", localPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], localPath, {
      timeoutMs,
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
): Promise<{ readonly path: string; readonly topLevel: string } | undefined> {
  try {
    const topLevel = await run(["git", "-C", localPath, "rev-parse", "--show-toplevel"], localPath, { timeoutMs });
    const resolved = await realpath(localPath);
    return { path: resolved, topLevel: topLevel.stdout.trim() };
  } catch {
    return undefined;
  }
}

async function remoteOrigin(localPath: string, run: GitCommandRunner, timeoutMs: number): Promise<string | undefined> {
  try {
    const result = await run(["git", "-C", localPath, "config", "--get", "remote.origin.url"], localPath, { timeoutMs });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function headAt(localPath: string, run: GitCommandRunner, timeoutMs: number): Promise<string | undefined> {
  try {
    const result = await run(["git", "-C", localPath, "rev-parse", "HEAD"], localPath, { timeoutMs });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function currentBranch(localPath: string, run: GitCommandRunner, timeoutMs: number): Promise<string | undefined> {
  try {
    const result = await run(["git", "-C", localPath, "rev-parse", "--abbrev-ref", "HEAD"], localPath, { timeoutMs });
    const value = result.stdout.trim();
    return value === "HEAD" ? undefined : value;
  } catch {
    return undefined;
  }
}

async function withLock<T>(lockPath: string, staleMs: number, operation: () => Promise<T>): Promise<T> {
  await acquireLock(lockPath, staleMs);
  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function acquireLock(lockPath: string, staleMs: number): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lockPath);
      writeLockOwner(lockPath).catch(() => undefined);
      return;
    } catch (error) {
      if (!isErrno(error) || error.code !== "EEXIST") throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > staleMs) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error("Timed out acquiring the repository cache lock");
      await sleep(50);
    }
  }
}

async function writeLockOwner(lockPath: string): Promise<void> {
  await writeFile(`${lockPath}/owner`, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8");
}

function runGitProcess(
  args: readonly string[],
  cwd: string,
  options: { readonly timeoutMs: number },
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      args[0]!,
      args.slice(1),
      { cwd, timeout: options.timeoutMs, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const exitCode = typeof (error as { code?: unknown }).code === "number" ? (error as { code?: number }).code : undefined;
          reject(
            Object.assign(new Error(trimOutput(stderr)), {
              gitExitCode: exitCode,
              code: (error as { code?: unknown }).code,
            }),
          );
          return;
        }
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
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

function trimOutput(value: string): string {
  return value.trim().slice(0, 500);
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}