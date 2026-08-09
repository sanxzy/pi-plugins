import {
  canonicalProjectRoot,
  createChannelLogger,
  createChannelManager,
  createTelegramTransport,
  type ChannelConfig,
  type ChannelManager,
  type ChannelPoller,
} from "@xzy-ai/channels";

export interface TelegramProjectManagerOptions {
  projectRoot: string;
  sessionId: string;
  createManager?: (projectRoot: string) => ChannelManager;
  createPoller?: (config: ChannelConfig, projectRoot: string, sessionId: string) => ChannelPoller;
}

interface TelegramProjectManagerEntry {
  manager: ChannelManager;
  sessionId: string;
}

const managersByProject = new Map<string, TelegramProjectManagerEntry>();

/** Share one manager between setup and session lifecycle for each canonical cwd. */
export function getTelegramProjectManager(options: TelegramProjectManagerOptions): ChannelManager {
  const projectRoot = canonicalProjectRoot(options.projectRoot);
  const existing = managersByProject.get(projectRoot);
  if (existing) {
    existing.sessionId = options.sessionId;
    return existing.manager;
  }

  const entry: TelegramProjectManagerEntry = {
    manager: options.createManager?.(projectRoot) ?? createChannelManager({
      projectRoot,
      createPoller: (config) => {
        const poller = options.createPoller?.(config, projectRoot, options.sessionId);
        if (poller) return poller;
        const loggerResult = createChannelLogger({ projectRoot, sessionId: options.sessionId });
        if (!loggerResult.ok) throw new Error("Unable to create Telegram connection log");
        return createTelegramTransport({ logger: loggerResult.value });
      },
    }),
    sessionId: options.sessionId,
  };
  managersByProject.set(projectRoot, entry);
  return entry.manager;
}

/** Test/observability seam: the manager already registered for a project, if any. */
export function getTelegramProjectManagerIfPresent(projectRoot: string): ChannelManager | undefined {
  return managersByProject.get(canonicalProjectRoot(projectRoot))?.manager;
}

/** Drop only one project's manager from the registry. */
export function clearTelegramProjectManager(projectRoot: string): void {
  managersByProject.delete(canonicalProjectRoot(projectRoot));
}

/** Drop every project's manager from the registry (test isolation). */
export function clearTelegramProjectManagers(): void {
  managersByProject.clear();
}
