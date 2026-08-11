import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { getChildPool } from "@xzy-ai/runtime";
import {
  canonicalProjectRoot,
  createTelegramChannelLifecycle,
  type ChannelConfig,
  type ChannelManager,
  type ChannelPoller,
  type TelegramChannelLifecycle,
  type TelegramMenuCommandSource,
} from "@xzy-ai/channels";
import {
  clearTelegramCommandContext,
} from "./telegram-controls.ts";
import {
  clearTelegramProjectManager,
  clearTelegramProjectManagers,
  getTelegramProjectManager,
} from "./telegram-project.ts";

export interface TelegramLifecycleRegistrationDeps {
  createManager?: (projectRoot: string) => ChannelManager;
  createPoller?: (config: ChannelConfig, projectRoot: string, sessionId: string) => ChannelPoller;
  /** Read the current Pi command/prompt/skill catalog for menu sync on start/restart. */
  getCommands?: () => readonly TelegramMenuCommandSource[];
}

const lifecyclesByProject = new Map<string, TelegramChannelLifecycle>();

/** True only for a host session, never for a registered child job. */
function isRootSession(ctx: ExtensionContext): boolean {
  const sessionId = ctx.sessionManager.getSessionId();
  const pool = getChildPool(ctx.cwd, sessionId);
  // The shared pool keeps its first rootSessionId across host replacement
  // (/new, reload, resume). The registry is the stable discriminator: child
  // sessions are jobs, while every replacement root is not.
  return pool.registry.get(sessionId) === undefined;
}

function lifecycleFor(
  projectRoot: string,
  sessionId: string,
  deps: TelegramLifecycleRegistrationDeps,
): TelegramChannelLifecycle {
  const existing = lifecyclesByProject.get(projectRoot);
  if (existing) return existing;

  const lifecycle = createTelegramChannelLifecycle({
    projectRoot,
    manager: getTelegramProjectManager({ ...deps, projectRoot, sessionId }),
  });
  lifecyclesByProject.set(projectRoot, lifecycle);
  return lifecycle;
}

/** Wire project Telegram start/stop to PI session lifecycle events. */
export function registerTelegramLifecycle(
  pi: ExtensionAPI,
  deps: TelegramLifecycleRegistrationDeps = {},
): void {
  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    if (!isRootSession(ctx)) return;
    const projectRoot = canonicalProjectRoot(ctx.cwd);
    const lifecycle = lifecycleFor(projectRoot, ctx.sessionManager.getSessionId(), deps);
    const started = await lifecycle.start();
    if (!started.ok && started.code !== "missing") {
      ctx.ui.notify(started.message, "warning");
    }
  });

  pi.on("session_shutdown", async (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
    if (!isRootSession(ctx)) return;
    const projectRoot = canonicalProjectRoot(ctx.cwd);
    clearTelegramCommandContext(projectRoot);
    const lifecycle = lifecyclesByProject.get(projectRoot);
    if (!lifecycle) return;
    await lifecycle.stop();
    lifecyclesByProject.delete(projectRoot);
    // Clear only the shut-down project's manager so another project in the same
    // process keeps its active connection and lifecycle identity.
    clearTelegramProjectManager(projectRoot);
  });
}

/** Test seam for process-local lifecycle isolation. */
export function clearTelegramLifecycleRegistry(): void {
  lifecyclesByProject.clear();
  clearTelegramProjectManagers();
}
