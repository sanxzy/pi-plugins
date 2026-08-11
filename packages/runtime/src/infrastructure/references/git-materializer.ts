/**
 * System-Git materialization for the references catalog.
 *
 * Uses the Git executable through a bounded child-process adapter. Checkouts
 * are isolated by normalized repository and branch identity, and operations
 * are serialized by a heartbeat-backed per-checkout lease.
 */
import { execFile } from "node:child_process";
import { mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
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
    throwIfAborted(input.signal);

    const localPath = cachePath(input.cacheRoot, input.reference, input.branch);
    const token = lockToken();
    try {
      return await withLock(
        `${localPath}.lock`,
        lockStaleMs,
        token,
        lockAcquireTimeoutMs,
        input.signal,
        async () => {
          await mkdir(dirname(localPath), { recursive: true });

          const existing = await discoverWorktree(localPath, run, timeoutMs, input.signal);
          const origin = existing ? await remoteOrigin(existing.path, run, timeoutMs, input.signal) : undefined;
          const actualBranch = existing ? await currentBranch(existing.path, run, timeoutMs, input.signal) : undefined;
          const defaultBranch = existing ? await defaultRemoteBranch(existing.path, run, timeoutMs, input.signal) : undefined;
          const expectedBranch = input.branch ?? defaultBranch;
          const originReference = origin ? parseRepository(stripGitCredentials(origin)) : undefined;
          const reuse = Boolean(
            existing &&
              existing.topLevel === existing.path &&
              originReference &&
              cacheIdentity(originReference) === cacheIdentity(input.reference) &&
              (expectedBranch === undefined || actualBranch === expectedBranch),
          );

          if (!reuse) await removeCheckout(localPath, input.signal);

          const status: GitMaterializeStatus = !reuse ? "cloned" : input.refresh ? "refreshed" : "cached";
          try {
            if (status === "cloned") {
              await clone(input.reference, localPath, input.branch, run, timeoutMs, input.signal);
            } else if (status === "refreshed") {
              await refresh(localPath, input.branch, run, timeoutMs, input.signal);
            }

            const branch = await currentBranch(localPath, run, timeoutMs, input.signal);
            const expectedAfterMaterialization =
              input.branch ?? (await defaultRemoteBranch(localPath, run, timeoutMs, input.signal));
            if (expectedAfterMaterialization !== undefined && branch !== expectedAfterMaterialization) {
              throw new Error("Git checkout branch did not match the requested branch");
            }
            const head = await headAt(localPath, run, timeoutMs, input.signal);
            return { localPath, status, head, branch };
          } catch (error) {
            if (status !== "cached") await removeCheckout(localPath, input.signal).catch(() => undefined);
            throw error;
          }
        },
      );
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
      throwIfAborted(input.signal);
      const args = ["git", "ls-remote", input.reference.remote];
      if (input.branch) args.push(`refs/heads/${input.branch}`);
      const result = await run(args, process.cwd(), { timeoutMs, signal: input.signal });
      if (input.branch) {
        const expected = `refs/heads/${input.branch}`;
        const found = result.stdout.split(/\r?\n/u).some((line) => line.trim().split(/\s+/u)[1] === expected);
        if (!found) return { ok: false, error: "Repository branch is not available" };
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
    return (result.stdout.trim() || undefined)?.replace(/^origin\//u, "");
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
  const result = await run(["git", "-C", localPath, "rev-parse", "HEAD"], localPath, { timeoutMs, signal });
  return result.stdout.trim() || undefined;
}

async function currentBranch(localPath: string, run: GitCommandRunner, timeoutMs: number, signal: AbortSignal | undefined): Promise<string | undefined> {
  const result = await run(["git", "-C", localPath, "rev-parse", "--abbrev-ref", "HEAD"], localPath, { timeoutMs, signal });
  const value = result.stdout.trim();
  return value === "HEAD" ? undefined : value;
}

async function removeCheckout(localPath: string, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  await rm(localPath, { recursive: true, force: true });
  throwIfAborted(signal);
}

async function withLock<T>(
  lockPath: string,
  staleMs: number,
  token: string,
  acquireTimeoutMs: number,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  await acquireLock(lockPath, staleMs, token, acquireTimeoutMs, signal);
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
  signal: AbortSignal | undefined,
): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + acquireTimeoutMs;
  for (;;) {
    throwIfAborted(signal);
    try {
      await mkdir(lockPath);
      await writeFile(`${lockPath}/owner`, token, "utf8");
      await writeFile(`${lockPath}/heartbeat`, String(Date.now()), "utf8");
      return;
    } catch (error) {
      if (!isErrno(error) || error.code !== "EEXIST") throw error;
      if (await isLockStale(lockPath, staleMs)) {
        await reclaimLock(lockPath, token);
        continue;
      }
      if (Date.now() > deadline) throw new Error("Timed out acquiring the repository cache lock");
      await sleep(50, signal);
    }
  }
}

async function reclaimLock(lockPath: string, token: string): Promise<void> {
  const graveyard = `${lockPath}~stale-${token}`;
  try {
    await rename(lockPath, graveyard);
    await rm(graveyard, { recursive: true, force: true });
  } catch (error) {
    if (isErrno(error) && (error.code === "ENOENT" || error.code === "EEXIST")) return;
    throw error;
  }
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  const graveyard = `${lockPath}~release-${token}`;
  try {
    const recorded = await readOwner(lockPath);
    if (recorded !== token) return;
    // Atomic reclaim: rename the lease directory to a unique graveyard before
    // removing it, so a contender that recreates the lease is never clobbered.
    await rename(lockPath, graveyard);
    await rm(graveyard, { recursive: true, force: true });
  } catch (error) {
    if (isErrno(error) && (error.code === "ENOENT" || error.code === "EEXIST")) return;
    throw error;
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
    const heartbeatInfo = await stat(`${lockPath}/heartbeat`).catch(() => undefined);
    const reference = heartbeatInfo ? heartbeatInfo.mtimeMs : dirInfo.mtimeMs;
    if (Date.now() - reference <= staleMs) return false;
    const owner = await readOwner(lockPath);
    const pid = owner ? Number.parseInt(owner.split("-", 1)[0] ?? "", 10) : Number.NaN;
    return !Number.isInteger(pid) || !processAlive(pid);
  } catch {
    return false;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error) && error.code === "EPERM";
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
    let settled = false;
    const onAbort = () => child.kill();
    const child = execFile(
      gitExecutable,
      args.slice(1),
      { cwd, timeout: options.timeoutMs, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        settled = true;
        options.signal?.removeEventListener("abort", onAbort);
        if (error) {
          const exitCode = typeof (error as { code?: unknown }).code === "number" ? (error as { code?: number }).code : undefined;
          reject(Object.assign(new Error(sanitizeOutput(stderr) || "Git command failed"), { gitExitCode: exitCode, code: (error as { code?: unknown }).code }));
          return;
        }
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
    if (options.signal) {
      if (options.signal.aborted) child.kill();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    void settled;
  });
}

function sanitizeOutput(value: string): string {
  const uriSafe = value.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/gu, "$1<redacted>@");
  const scpSafe = uriSafe.replace(/(^|[\s"'(])[^@\s/:]+(?::[^@\s]*)?@(?=[^/\s:]+:)/gu, "$1<redacted>@");
  const message = scpSafe.trim().slice(0, 500);
  return message.length > 0 ? message : "Git command failed";
}

function sanitizeError(error: unknown): string {
  return sanitizeOutput(error instanceof Error ? error.message : String(error));
}

function stripGitCredentials(remote: string): string {
  try {
    const url = new URL(remote);
    if (url.username) url.username = "";
    if (url.password) url.password = "";
    return url.toString();
  } catch {
    return remote.replace(/^[^@\s]+@(?=[^/\s:]+:)/u, "");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Git materialization aborted");
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null;
}

async function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Git materialization aborted"));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}
