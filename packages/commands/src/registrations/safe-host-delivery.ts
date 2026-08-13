import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type HostDeliverAs = "steer" | "followUp";

export interface HostMessageGate {
  /** Queue a host-bound model message for a safe idle boundary. */
  send(content: string, deliverAs?: HostDeliverAs): void;
  /** Attempt delivery without retaining the message; false means retry later. */
  trySend(content: string, deliverAs?: HostDeliverAs): boolean;
  /** Whether the host can accept a new prompt without racing an active run. */
  ready(): boolean;
  /**
   * Drop queued messages and pending retry timers. Called from `session_shutdown`
   * so a gate never outlives its session's extension runner, whose context
   * getters throw after replacement.
   */
  dispose(): void;
}

interface QueuedMessage {
  readonly content: string;
  readonly deliverAs: HostDeliverAs;
}

/** Backoff for re-delivery while the host run settles (agent_end / reload). */
const RETRY_STEPS_MS = [25, 50, 100, 200, 400, 800, 1600];

/**
 * Protect host-bound messages from pi's prompt lifecycle race.
 *
 * `pi.sendUserMessage()` eventually calls `agent.prompt()`. During session
 * reload/replacement, `isIdle()` can briefly report the host as available while
 * the underlying agent still owns an active run, causing pi's `<runtime>` error
 * "Agent is already processing a prompt" and, for delivery, a falsely-marked
 * delivered result. Messages are therefore held until the host is idle, has no
 * pending messages, and has no active abort signal. `agent_end` plus a bounded
 * backoff cover both normal run completion and runtime replacement ordering
 * without requiring callers to poll the host.
 *
 * Lifecycle: every gate belongs to exactly one session and must be disposed on
 * `session_shutdown`. A disposed gate clears its queue and timer so a stale
 * extension context (whose getters throw after runner invalidation) can never
 * be touched by a surviving timer; as defense in depth the timer callback also
 * swallows any throw so an uncaught exception can never escape.
 *
 * Residual race (documented, no SDK API to observe): `sendUserMessage` is
 * void-typed and the pi runner swallows async rejections, so a send that slips
 * into the tiny precondition window surfaces only as a `<runtime>` error, not
 * as a throw the gate can catch. The pre-check plus `agent_end` backoff keeps
 * that window effectively closed for lifecycle-driven sends.
 */
export function createHostMessageGate(pi: ExtensionAPI, ctx: ExtensionContext): HostMessageGate {
  const queue: QueuedMessage[] = [];
  let retryTimer: NodeJS.Timeout | undefined;
  let retryStep = 0;
  let disposed = false;

  const hostIsReady = (): boolean => {
    // A replaced runner's context getters throw. Treat an unreadable context as
    // busy so the gate only ever defers or disposes, never crashes.
    try {
      return typeof ctx.isIdle === "function" && typeof ctx.hasPendingMessages === "function"
        ? ctx.isIdle() && !ctx.hasPendingMessages() && ctx.signal === undefined
        : true;
    } catch {
      return false;
    }
  };

  const scheduleFlush = (): void => {
    if (disposed || retryTimer !== undefined || queue.length === 0) return;
    const delayMs = RETRY_STEPS_MS[Math.min(retryStep, RETRY_STEPS_MS.length - 1)];
    retryStep += 1;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      try {
        flush();
      } catch {
        // A stale (invalidated) context can throw from its getters. Never let a
        // timer callback raise an uncaught exception that pi's TUI handles by
        // exiting the process; drop the queue so nothing retries forever.
        queue.length = 0;
      }
    }, delayMs);
    retryTimer.unref?.();
  };

  const flush = (): void => {
    if (disposed || queue.length === 0) return;
    if (!hostIsReady()) {
      scheduleFlush();
      return;
    }

    // Deliver one message per idle boundary. The first send can start a new
    // host run asynchronously; sending the rest in the same tick would race
    // that run before the host state becomes observable.
    const next = queue.shift()!;
    try {
      pi.sendUserMessage(next.content, { deliverAs: next.deliverAs });
    } catch {
      queue.unshift(next);
    }
    if (queue.length > 0) scheduleFlush();
  };

  pi.on("agent_end", () => scheduleFlush());

  return {
    send(content: string, deliverAs: HostDeliverAs = "steer"): void {
      if (disposed) return;
      queue.push({ content, deliverAs });
      flush();
    },
    trySend(content: string, deliverAs: HostDeliverAs = "steer"): boolean {
      if (disposed || !hostIsReady()) return false;
      try {
        pi.sendUserMessage(content, { deliverAs });
        return true;
      } catch {
        return false;
      }
    },
    ready: () => !disposed && hostIsReady(),
    dispose(): void {
      disposed = true;
      queue.length = 0;
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
    },
  };
}
