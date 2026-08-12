import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pendingDeliveryFile } from "../../shared/paths.ts";

/**
 * Coordinates durable result delivery without coupling the pool to the PI SDK.
 *
 * A sink belongs to one parent session file. Results are addressed by that
 * exact file so a child can only notify its direct parent, even when several
 * extension instances share the same project pool. Pending results are
 * persisted so a dead/reloaded parent can receive them later.
 */
export interface DeliveryCoordinator {
  readonly activeCount: number;
  readonly pendingCount: number;
  register(sessionFile: string, deliver: (content: string) => void): void;
  unregister(sessionFile: string): void;
  /** Move pending results from a replaced parent session to its descendant. */
  rebind(previousSessionFile: string, nextSessionFile: string): void;
  deliverResult(jobId: string, parentSessionFile: string, content: string): boolean;
}

interface PendingResult {
  readonly jobId: string;
  parentSessionFile: string;
  readonly content: string;
}

export interface DeliveryCoordinatorOptions {
  /** Project root used for the durable pending-result queue. */
  readonly projectRoot?: string;
  /** Called after a pending result is successfully delivered on re-register. */
  readonly onDelivered?: (jobId: string) => void;
}

function loadPending(path: string | undefined): PendingResult[] {
  if (!path || !existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PendingResult => Boolean(
      item && typeof item === "object" &&
      typeof (item as PendingResult).jobId === "string" &&
      typeof (item as PendingResult).parentSessionFile === "string" &&
      typeof (item as PendingResult).content === "string",
    ));
  } catch {
    return [];
  }
}

function persistPending(path: string | undefined, pending: readonly PendingResult[]): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(pending, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

export function createDeliveryCoordinator(options: DeliveryCoordinatorOptions = {}): DeliveryCoordinator {
  const sinks = new Map<string, (content: string) => void>();
  const pendingPath = options.projectRoot ? pendingDeliveryFile(options.projectRoot) : undefined;
  const pending: PendingResult[] = loadPending(pendingPath);

  const persist = (): void => {
    persistPending(pendingPath, pending);
  };

  const deliverPending = (sessionFile: string): void => {
    const sink = sinks.get(sessionFile);
    if (!sink) return;

    let changed = false;
    for (let index = 0; index < pending.length;) {
      const result = pending[index];
      if (result.parentSessionFile !== sessionFile) {
        index += 1;
        continue;
      }

      try {
        sink(result.content);
        pending.splice(index, 1);
        changed = true;
        options.onDelivered?.(result.jobId);
      } catch {
        // Keep the result pending if the host rejects delivery while a session
        // is being replaced. A later registration can retry it safely.
        index += 1;
      }
    }
    if (changed) persist();
  };

  return {
    get activeCount() {
      return sinks.size;
    },
    get pendingCount() {
      return pending.length;
    },
    register(sessionFile, deliver): void {
      sinks.set(sessionFile, deliver);
      deliverPending(sessionFile);
    },
    unregister(sessionFile): void {
      sinks.delete(sessionFile);
    },
    rebind(previousSessionFile, nextSessionFile): void {
      if (previousSessionFile === nextSessionFile) return;
      // A result addressed to the replaced parent belongs to the descendant
      // session that continues the same conversation, so it must follow the
      // fork. Live sinks are not moved: those sessions are shared jobs, not a
      // parent waiting for a result.
      let changed = false;
      for (const result of pending) {
        if (result.parentSessionFile === previousSessionFile) {
          result.parentSessionFile = nextSessionFile;
          changed = true;
        }
      }
      if (changed) persist();
    },
    deliverResult(jobId, parentSessionFile, content): boolean {
      const sink = sinks.get(parentSessionFile);
      if (!sink) {
        pending.push({ jobId, parentSessionFile, content });
        persist();
        return false;
      }

      try {
        sink(content);
        return true;
      } catch {
        pending.push({ jobId, parentSessionFile, content });
        persist();
        return false;
      }
    },
  };
}
