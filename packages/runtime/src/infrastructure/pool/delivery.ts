import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PERSISTENCE_OPERATIONS, processWithLog } from "@xzy-ai/observability";
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
  /** Re-drive durable pending delivery now (called after the host settles). */
  redrive(sessionFile?: string): void;
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
  /** Root session owning this coordinator's pending-result queue. */
  readonly rootSessionId?: string;
  /** Called after a pending result is successfully delivered on re-register. */
  readonly onDelivered?: (jobId: string) => void;
  /**
   * Delay before re-driving delivery to a registered sink that rejected it
   * (e.g. a busy host mid-run). Defaults to 2000ms. Timers are unref'd so
   * they never hold the process open.
   */
  readonly retryDelayMs?: number;
}

function loadPending(path: string | undefined): PendingResult[] {
  let loaded: PendingResult[] = [];
  processWithLog({ operation: PERSISTENCE_OPERATIONS.DELIVERY_LOAD, parameters: { path } }, () => {
    if (!path || !existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return;
      loaded = parsed.filter((item): item is PendingResult => Boolean(
        item && typeof item === "object" &&
        typeof (item as PendingResult).jobId === "string" &&
        typeof (item as PendingResult).parentSessionFile === "string" &&
        typeof (item as PendingResult).content === "string",
      ));
    } catch {
      // Corruption is tolerated: the queue is rebuilt from fresh results. This is
      // the explicit policy chosen for M14; a corrupt file is never fatal.
    }
  });
  return loaded;
}

function persistPending(path: string | undefined, pending: readonly PendingResult[]): void {
  processWithLog({ operation: PERSISTENCE_OPERATIONS.DELIVERY_PERSIST, parameters: { path } }, () => {
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(pending, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  });
}

export function createDeliveryCoordinator(options: DeliveryCoordinatorOptions = {}): DeliveryCoordinator {
  const sinks = new Map<string, (content: string) => void>();
  const pendingPath = options.projectRoot && options.rootSessionId
    ? pendingDeliveryFile(options.projectRoot, options.rootSessionId)
    : undefined;
  const pending: PendingResult[] = loadPending(pendingPath);
  const retryDelayMs = options.retryDelayMs ?? 2_000;
  const retryTimers = new Map<string, NodeJS.Timeout>();

  const persist = (): void => {
    persistPending(pendingPath, pending);
  };

  /** Re-drive delivery for a registered parent whose sink rejected a result. */
  const scheduleRetry = (sessionFile: string): void => {
    if (retryTimers.has(sessionFile)) return;
    const timer = setTimeout(() => {
      retryTimers.delete(sessionFile);
      // The parent may have disappeared while waiting; only re-drive when the
      // sink is still registered so nothing is delivered out of scope.
      if (!sinks.has(sessionFile)) return;
      deliverPending(sessionFile);
    }, retryDelayMs);
    timer.unref?.();
    retryTimers.set(sessionFile, timer);
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
        // The host rejected delivery (e.g. the agent is mid-run during a
        // reload). Keep the result pending and re-drive once the host settles
        // instead of only waiting for the next registration.
        index += 1;
        scheduleRetry(sessionFile);
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
      processWithLog({ operation: PERSISTENCE_OPERATIONS.DELIVERY_REGISTER, parameters: { sessionFile } }, () => {
        sinks.set(sessionFile, deliver);
        deliverPending(sessionFile);
      });
    },
    unregister(sessionFile): void {
      if (!sinks.has(sessionFile)) return;
      processWithLog({ operation: PERSISTENCE_OPERATIONS.DELIVERY_UNREGISTER, parameters: { sessionFile } }, () => {
        sinks.delete(sessionFile);
      });
    },
    rebind(previousSessionFile, nextSessionFile): void {
      if (previousSessionFile === nextSessionFile) return;
      if (!pending.some((result) => result.parentSessionFile === previousSessionFile)) return;
      processWithLog({ operation: PERSISTENCE_OPERATIONS.DELIVERY_REBIND, parameters: { from: previousSessionFile, to: nextSessionFile } }, () => {
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
      });
    },
    redrive(sessionFile?: string): void {
      if (sessionFile !== undefined) {
        deliverPending(sessionFile);
        return;
      }
      for (const registered of sinks.keys()) deliverPending(registered);
    },
    deliverResult(jobId, parentSessionFile, content): boolean {
      return processWithLog({ operation: PERSISTENCE_OPERATIONS.DELIVERY_RESULT, parameters: { jobId, parentSessionFile } }, () => {
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
        scheduleRetry(parentSessionFile);
        return false;
      }
      });
    },
  };
}
