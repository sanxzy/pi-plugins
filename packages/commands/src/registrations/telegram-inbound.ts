import type {
  AgentSettledEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { getChildPool } from "@xzy-ai/runtime";
import {
  createTelegramLifecycle,
  loadChannelConfig,
  saveConnectionMarker,
  type TelegramLifecycle,
  type TelegramLifecycleOptions,
} from "@xzy-ai/channels";

export interface TelegramInboundDeps {
  /** Injectable lifecycle factory for root/child and shutdown tests. */
  createLifecycle?: (options: TelegramLifecycleOptions) => TelegramLifecycle;
}

/**
 * True only for the root orchestrator session.
 *
 * The shared pool is created by the root host session and its `rootSessionId`
 * is fixed at creation; a child session (a job in the scoped registry) never
 * matches it. The registry guard is retained as a fail-safe for malformed state.
 */
function isRootSession(ctx: ExtensionContext): boolean {
  const sessionId = ctx.sessionManager.getSessionId();
  const pool = getChildPool(ctx.cwd, sessionId);
  return pool.rootSessionId === sessionId && pool.registry.get(sessionId) === undefined;
}

/**
 * Wire the authorized Telegram inbound path into the extension lifecycle.
 *
 * On `session_start` for the root orchestrator session, this starts the
 * channels Telegram lifecycle from the project-local channel config and injects
 * every accepted message into the root session as a follow-up. The approved
 * boundary passes `pi.getCommands()` into the lifecycle. On root settlement,
 * cancellation, or error the shared typing loop stops; on `session_shutdown`
 * the listener stops.
 */
export function registerTelegramInbound(pi: ExtensionAPI, deps: TelegramInboundDeps = {}): void {
  const createLifecycle = deps.createLifecycle ?? createTelegramLifecycle;
  const runningByProject = new Map<string, TelegramLifecycle>();

  pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
    const channel = loadChannelConfig(ctx.cwd);
    if (channel === null) return;

    // Only the root orchestrator session owns Telegram input; a child session
    // never listens and never injects follow-ups.
    if (!isRootSession(ctx)) return;

    const lifecycle = createLifecycle({
      projectRoot: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      sendFollowUp(content, options) {
        pi.sendUserMessage(content, options);
        return Promise.resolve();
      },
      setTelegramMarker() {
        saveConnectionMarker(ctx.cwd, {
          lastConnection: "telegram",
          updatedAt: new Date().toISOString(),
        });
      },
    });

    // The lifecycle owns the bot middleware and polling; the command list comes
    // from the caller per the approved boundary (menu sync lands in Phase 6).
    void lifecycle.start(pi.getCommands()).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.warn(`Telegram inbound failed to start: ${message}`);
    });
    runningByProject.set(ctx.cwd, lifecycle);
  });

  // Stop the shared typing loop when the root run settles, is cancelled, or
  // errors. A new turn restarts it through the next accepted message.
  pi.on("agent_settled", (_event: AgentSettledEvent, ctx: ExtensionContext) => {
    runningByProject.get(ctx.cwd)?.stopTyping();
  });
  pi.on("turn_start", (_event: TurnStartEvent, ctx: ExtensionContext) => {
    runningByProject.get(ctx.cwd)?.stopTyping();
  });

  pi.on("session_shutdown", async (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
    const lifecycle = runningByProject.get(ctx.cwd);
    if (!lifecycle) return;
    runningByProject.delete(ctx.cwd);
    await lifecycle.stop().catch(() => {
      // Best-effort; the listener may already be gone.
    });
  });
}