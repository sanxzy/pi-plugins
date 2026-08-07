/**
 * FIFO concurrency gate for child sessions.
 *
 * PI executes tool calls in one model response concurrently by default. The
 * gate is shared by the project pool so every agent call observes one global
 * child limit rather than creating a limit per extension instance.
 */

interface Waiter {
  resolve(): void;
}

export interface ConcurrencyGate {
  readonly activeCount: number;
  readonly queuedCount: number;
  run<T>(operation: () => Promise<T>): Promise<T>;
  /**
   * Count agent calls issued in the current model response.
   *
   * The counter is shared through the pool so every extension instance observes
   * one per-response limit. It is reset from `turn_start` and defends AC4: a
   * response issuing more than `MAX_PARALLEL_AGENTS` agent calls is rejected.
   */
  readonly parallelAgentsInResponse: number;
  resetParallelCount(): void;
  /** Register one agent call; true when the response-wide limit is still open. */
  countAgentCall(maxParallelAgents: number): boolean;
}

export function createConcurrencyGate(maxConcurrency: number): ConcurrencyGate {
  const limit = Math.max(1, Math.floor(maxConcurrency));
  let activeCount = 0;
  let parallelAgentsInResponse = 0;
  const queue: Waiter[] = [];

  const admitNext = (): void => {
    while (activeCount < limit && queue.length > 0) {
      activeCount += 1;
      queue.shift()!.resolve();
    }
  };

  const acquire = (): Promise<void> => {
    if (activeCount < limit) {
      activeCount += 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      queue.push({ resolve });
    });
  };

  const release = (): void => {
    activeCount -= 1;
    admitNext();
  };

  return {
    get activeCount() {
      return activeCount;
    },
    get queuedCount() {
      return queue.length;
    },
    get parallelAgentsInResponse() {
      return parallelAgentsInResponse;
    },
    resetParallelCount(): void {
      parallelAgentsInResponse = 0;
    },
    countAgentCall(maxParallelAgents: number): boolean {
      parallelAgentsInResponse += 1;
      return parallelAgentsInResponse <= maxParallelAgents;
    },
    async run<T>(operation: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await operation();
      } finally {
        release();
      }
    },
  };
}
