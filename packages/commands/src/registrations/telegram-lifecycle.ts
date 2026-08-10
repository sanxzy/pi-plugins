import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
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
    const projectRoot = canonicalProjectRoot(ctx.cwd);
    const lifecycle = lifecycleFor(projectRoot, ctx.sessionManager.getSessionId(), deps);
    const started = await lifecycle.start();
    if (!started.ok && started.code !== "missing") {
      ctx.ui.notify(started.message, "warning");
    }
  });

  pi.on("session_shutdown", async (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
    const projectRoot = canonicalProjectRoot(ctx.cwd);
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
