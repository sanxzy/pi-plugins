/**
 * FIFO concurrency gate for child sessions.
 *
 * PI executes tool calls in one model response concurrently by default. The
 * gate is shared through the project pool so every agent call observes one
 * global child limit rather than creating a limit per extension instance.
 */

interface Waiter {
  resolve(): void;
  reject(reason: unknown): void;
  signal?: AbortSignal;
  cleanup(): void;
}

export interface ConcurrencyGate {
  readonly activeCount: number;
  readonly queuedCount: number;
  run<T>(operation: () => Promise<T>): Promise<T>;
  /** Run under the gate and reject a queued operation when its signal aborts. */
  runWithSignal<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Count agent calls issued in the current model response. */
  readonly parallelAgentsInResponse: number;
  resetParallelCount(): void;
  /** Register one agent call; true when the response-wide limit is still open. */
  countAgentCall(maxParallelAgents: number): boolean;
}

function abortedError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

export function createConcurrencyGate(maxConcurrency: number): ConcurrencyGate {
  const limit = Math.max(1, Math.floor(maxConcurrency));
  let activeCount = 0;
  let parallelAgentsInResponse = 0;
  const queue: Waiter[] = [];

  const admitNext = (): void => {
    while (activeCount < limit && queue.length > 0) {
      const waiter = queue.shift()!;
      if (waiter.signal?.aborted) {
        waiter.reject(abortedError());
        continue;
      }
      activeCount += 1;
      waiter.cleanup();
      waiter.resolve();
    }
  };

  const release = (): void => {
    activeCount -= 1;
    admitNext();
  };

  const acquire = (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return Promise.reject(abortedError());
    if (activeCount < limit) {
      activeCount += 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let waiter!: Waiter;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        reject(abortedError());
      };
      waiter = {
        signal,
        resolve: () => {
          if (settled) return;
          settled = true;
          resolve();
        },
        reject: (reason) => {
          if (settled) return;
          settled = true;
          reject(reason);
        },
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      queue.push(waiter);
    });
  };

  const runWithSignal = async <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    await acquire(signal);
    try {
      return await operation();
    } finally {
      release();
    }
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
    run<T>(operation: () => Promise<T>): Promise<T> {
      return runWithSignal(operation);
    },
    runWithSignal,
  };
}
