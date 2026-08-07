/**
 * Coordinates result delivery without coupling the pool to the PI SDK.
 *
 * A sink belongs to one parent session file. Results are addressed by that
 * exact file so a child can only notify its direct parent, even when several
 * extension instances share the same project pool.
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

export function createDeliveryCoordinator(): DeliveryCoordinator {
  const sinks = new Map<string, (content: string) => void>();
  const pending: PendingResult[] = [];

  const deliverPending = (sessionFile: string): void => {
    const sink = sinks.get(sessionFile);
    if (!sink) return;

    for (let index = 0; index < pending.length;) {
      const result = pending[index];
      if (result.parentSessionFile !== sessionFile) {
        index += 1;
        continue;
      }

      try {
        sink(result.content);
        pending.splice(index, 1);
      } catch {
        // Keep the result pending if the host rejects delivery while a session
        // is being replaced. A later registration can retry it safely.
        index += 1;
      }
    }
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
      for (const result of pending) {
        if (result.parentSessionFile === previousSessionFile) {
          result.parentSessionFile = nextSessionFile;
        }
      }
    },
    deliverResult(jobId, parentSessionFile, content): boolean {
      const sink = sinks.get(parentSessionFile);
      if (!sink) {
        pending.push({ jobId, parentSessionFile, content });
        return false;
      }

      try {
        sink(content);
        return true;
      } catch {
        pending.push({ jobId, parentSessionFile, content });
        return false;
      }
    },
  };
}
