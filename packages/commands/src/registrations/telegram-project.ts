import {
  canonicalProjectRoot,
  createChannelLogger,
  createChannelManager,
  createTelegramTransport,
  buildTelegramBotCommands,
  type ChannelConfig,
  type ChannelManager,
  type ChannelPoller,
  type TelegramMenuCommandSource,
  type TelegramMessageHandler,
} from "@xzy-ai/channels";

export interface TelegramProjectManagerOptions {
  projectRoot: string;
  sessionId: string;
  createManager?: (projectRoot: string) => ChannelManager;
  createPoller?: (config: ChannelConfig, projectRoot: string, sessionId: string) => ChannelPoller;
  createMessageHandler?: (config: ChannelConfig) => TelegramMessageHandler;
  /** Read the current Pi command/prompt/skill catalog for menu sync and expansion. */
  getCommands?: () => readonly TelegramMenuCommandSource[];
}

interface TelegramProjectManagerEntry {
  manager: ChannelManager;
  sessionId: string;
  messageHandlerFactory?: (config: ChannelConfig) => TelegramMessageHandler;
  getCommands?: () => readonly TelegramMenuCommandSource[];
}

const managersByProject = new Map<string, TelegramProjectManagerEntry>();

/** Share one manager between setup and session lifecycle for each canonical cwd. */
export function getTelegramProjectManager(options: TelegramProjectManagerOptions): ChannelManager {
  const projectRoot = canonicalProjectRoot(options.projectRoot);
  const existing = managersByProject.get(projectRoot);
  if (existing) {
    existing.sessionId = options.sessionId;
    if (options.createMessageHandler) existing.messageHandlerFactory = options.createMessageHandler;
    if (options.getCommands) existing.getCommands = options.getCommands;
    return existing.manager;
  }

  const entry: TelegramProjectManagerEntry = {
    manager: undefined as never,
    sessionId: options.sessionId,
    messageHandlerFactory: options.createMessageHandler,
    getCommands: options.getCommands,
  };
  entry.manager = options.createManager?.(projectRoot) ?? createChannelManager({
    projectRoot,
    createPoller: (config) => {
      const poller = options.createPoller?.(config, projectRoot, entry.sessionId);
      if (poller) return poller;
      const loggerResult = createChannelLogger({ projectRoot, sessionId: entry.sessionId });
      if (!loggerResult.ok) throw new Error("Unable to create Telegram connection log");
      return createTelegramTransport({
        logger: loggerResult.value,
        onMessage: entry.messageHandlerFactory?.(config),
        commands: () => buildTelegramBotCommands(entry.getCommands?.() ?? []),
      });
    },
  });
  managersByProject.set(projectRoot, entry);
  return entry.manager;
}

/** The current inbound message-handler factory for a project, if one was registered. */
export function getTelegramMessageHandlerFactory(projectRoot: string): ((config: ChannelConfig) => TelegramMessageHandler) | undefined {
  return managersByProject.get(canonicalProjectRoot(projectRoot))?.messageHandlerFactory;
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
