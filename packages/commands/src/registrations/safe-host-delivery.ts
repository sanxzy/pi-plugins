import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type HostDeliverAs = "steer" | "followUp";

const HIDDEN_HOST_MESSAGE_TYPE = "pi-c2:internal-context";

export interface HostMessageGate {
  /** Queue a user-visible host message for a safe idle boundary. */
  send(content: string, deliverAs?: HostDeliverAs): void;
  /** Queue model-only context for a safe idle boundary. */
  sendHidden(content: string, deliverAs?: HostDeliverAs): void;
  /** Attempt visible delivery without retaining the message; false means retry later. */
  trySend(content: string, deliverAs?: HostDeliverAs): boolean;
  /** Attempt hidden delivery without retaining the message; false means retry later. */
  trySendHidden(content: string, deliverAs?: HostDeliverAs): boolean;
  /** Whether the host can accept a new prompt without racing an active run. */
  ready(): boolean;
  /**
   * Drop queued messages and pending retry timers. Called from `session_shutdown`
   * so a gate never outlives its session's extension runner, whose context
   * getters throw after replacement.
   */
  dispose(): void;
  /** Register a callback invoked after the host-run latch is released. */
  onSettled(listener: () => void): void;
}

interface QueuedMessage {
  readonly content: string;
  readonly deliverAs: HostDeliverAs;
  readonly hidden: boolean;
}

/** Backoff for re-delivery while the host run settles (agent_end / reload). */
const RETRY_STEPS_MS = [25, 50, 100, 200, 400, 800, 1600];
// Pi 0.80 emits no extension-level `agent_settled` event. Two consecutive
// idle observations provide a compatibility boundary without reopening the
// original agent_end race on runtimes that do support the event.
const LEGACY_SETTLE_SAMPLE_MS = 50;

/**
 * Protect host-bound messages from pi's prompt lifecycle race.
 *
 * `pi.sendUserMessage()` eventually calls `agent.prompt()`. During session
 * reload/replacement, `isIdle()` can briefly report the host as available while
 * the underlying agent still owns an active run, causing pi's `<runtime>` error
 * "Agent is already processing a prompt" and, for delivery, a falsely-marked
 * delivered result. Messages are therefore held until the host is idle, has no
 * pending messages, and has no active abort signal. `agent_end` plus a bounded
 * backoff cover both normal run completion and runtime replacement ordering.
 * Modern runtimes additionally emit
 * `agent_settled`; older runtimes use two stable-idle samples after
 * `agent_end` as the compatibility settlement boundary
 * without requiring callers to poll the host.
 *
 * Lifecycle: every gate belongs to exactly one session and must be disposed on
 * `session_shutdown`. A disposed gate clears its queue and timer so a stale
 * extension context (whose getters throw after runner invalidation) can never
 * be touched by a surviving timer; as defense in depth the timer callback also
 * swallows any throw so an uncaught exception can never escape.
 *
 * Residual race (closed at the lifecycle boundary): `sendUserMessage` is
 * void-typed and the pi runner swallows async rejections, so a send that slips
 * into the tiny precondition window surfaces only as a `<runtime>` error, not
 * as a throw the gate can catch. The gate therefore latches the run state from
 * explicit lifecycle events (`turn_start` .. `agent_settled`) and never sends
 * outside that fully-settled window; `ctx.isIdle()` backoff is only a final
 * safety net, not the primary guard.
 */
export function createHostMessageGate(pi: ExtensionAPI, ctx: ExtensionContext): HostMessageGate {
  const queue: QueuedMessage[] = [];
  let retryTimer: NodeJS.Timeout | undefined;
  let settleTimer: NodeJS.Timeout | undefined;
  let retryStep = 0;
  let idleSamples = 0;
  let disposed = false;
  // `isIdle()` can briefly be stale around a turn boundary, and pi itself
  // still finalizes work between `agent_end` and the fully-settled state. The
  // explicit lifecycle latch closes that race: from `turn_start` until
  // `agent_settled` the gate refuses every host send, regardless of the
  // instantaneous SDK getter.
  let turnActive = false;
  let hostSettled = true;
  // `sendUserMessage()` is void-typed and may not synchronously update the
  // SDK's idle getter. Treat an accepted send as in flight until the next
  // lifecycle settlement so a burst of pending results can never start two
  // prompts in the same tick.
  let sendInFlight = false;
  const settledListeners: Array<() => void> = [];
  const unsubscribeLifecycle: Array<() => void> = [];

  const hostIsReady = (): boolean => {
    // A replaced runner's context getters throw. Treat an unreadable context as
    // busy so the gate only ever defers or disposes, never crashes.
    try {
      if (turnActive || !hostSettled || sendInFlight) return false;
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

  const deliver = (message: QueuedMessage): void => {
    if (message.hidden) {
      pi.sendMessage(
        { customType: HIDDEN_HOST_MESSAGE_TYPE, content: message.content, display: false },
        { triggerTurn: true, deliverAs: message.deliverAs },
      );
      return;
    }
    pi.sendUserMessage(message.content, { deliverAs: message.deliverAs });
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
      deliver(next);
      sendInFlight = true;
    } catch {
      queue.unshift(next);
    }
    if (queue.length > 0) scheduleFlush();
  };

  const contextIsIdle = (): boolean => {
    try {
      return typeof ctx.isIdle === "function" && typeof ctx.hasPendingMessages === "function"
        ? ctx.isIdle() && !ctx.hasPendingMessages() && ctx.signal === undefined
        : true;
    } catch {
      return false;
    }
  };

  const settleHost = (): void => {
    if (disposed || hostSettled) return;
    hostSettled = true;
    sendInFlight = false;
    retryStep = 0;
    scheduleFlush();
    for (const listener of settledListeners) {
      try {
        listener();
      } catch {
        // A listener (the delivery redrive) may touch a disposed coordinator;
        // a settled host must never surface extension exceptions.
      }
    }
  };

  const scheduleLegacySettle = (): void => {
    if (disposed || settleTimer !== undefined) return;
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      if (disposed || turnActive) return;
      if (!contextIsIdle()) {
        idleSamples = 0;
        scheduleLegacySettle();
        return;
      }
      idleSamples += 1;
      if (idleSamples < 2) {
        scheduleLegacySettle();
        return;
      }
      idleSamples = 0;
      settleHost();
    }, LEGACY_SETTLE_SAMPLE_MS);
    settleTimer.unref?.();
  };

  const onTurnStart = (): void => {
    turnActive = true;
    hostSettled = false;
    idleSamples = 0;
  };
  const onAgentEnd = (): void => {
    turnActive = false;
    retryStep = 0;
    // Newer Pi versions call onAgentSettled. Older versions (including the
    // runtime currently launching this extension) need an explicit stable-idle
    // fallback or durable deliveries remain pending forever.
    scheduleLegacySettle();
    scheduleFlush();
  };
  const onAgentSettled = (): void => {
    if (settleTimer !== undefined) {
      clearTimeout(settleTimer);
      settleTimer = undefined;
    }
    idleSamples = 0;
    turnActive = false;
    settleHost();
  };
  const turnStartUnsubscribe = pi.on("turn_start", onTurnStart) as unknown as (() => void) | undefined;
  const agentEndUnsubscribe = pi.on("agent_end", onAgentEnd) as unknown as (() => void) | undefined;
  const agentSettledUnsubscribe = pi.on("agent_settled", onAgentSettled) as unknown as (() => void) | undefined;
  if (typeof turnStartUnsubscribe === "function") unsubscribeLifecycle.push(turnStartUnsubscribe);
  if (typeof agentEndUnsubscribe === "function") unsubscribeLifecycle.push(agentEndUnsubscribe);
  if (typeof agentSettledUnsubscribe === "function") unsubscribeLifecycle.push(agentSettledUnsubscribe);

  const tryDeliver = (content: string, deliverAs: HostDeliverAs, hidden: boolean): boolean => {
    if (disposed || !hostIsReady()) return false;
    try {
      deliver({ content, deliverAs, hidden });
      sendInFlight = true;
      return true;
    } catch {
      return false;
    }
  };

  return {
    send(content: string, deliverAs: HostDeliverAs = "steer"): void {
      if (disposed) return;
      queue.push({ content, deliverAs, hidden: false });
      flush();
    },
    sendHidden(content: string, deliverAs: HostDeliverAs = "steer"): void {
      if (disposed) return;
      queue.push({ content, deliverAs, hidden: true });
      flush();
    },
    trySend(content: string, deliverAs: HostDeliverAs = "steer"): boolean {
      return tryDeliver(content, deliverAs, false);
    },
    trySendHidden(content: string, deliverAs: HostDeliverAs = "steer"): boolean {
      return tryDeliver(content, deliverAs, true);
    },
    ready: () => !disposed && hostIsReady(),
    onSettled(listener: () => void): void {
      if (disposed) return;
      settledListeners.push(listener);
    },
    dispose(): void {
      disposed = true;
      turnActive = false;
      hostSettled = false;
      settledListeners.length = 0;
      for (const unsubscribe of unsubscribeLifecycle.splice(0)) unsubscribe();
      queue.length = 0;
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      if (settleTimer !== undefined) {
        clearTimeout(settleTimer);
        settleTimer = undefined;
      }
    },
  };
}
