import { loadChannelConfig, saveChannelConfig, type ChannelConfig } from "../state/index.ts";

/** The single-polling-consumer contract drives reconfiguration. */
export interface SetupBotSurface {
  getMe(): Promise<unknown>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface SetupControllerOptions {
  projectRoot: string;
  createBot: (token: string) => SetupBotSurface;
  now?: () => string;
}

export interface SetupControllerState {
  phase: "token" | "discovery" | "review";
  hasExistingToken: boolean;
  tokenConfigured: boolean;
  /** The stored token is never exposed to the widget; only this flag is. */
  maskedTokenExposed: false;
  candidates: string[];
  allowedChatIds: string[];
  defaultChatId: string | undefined;
}

export type ControllerResult = { ok: true } | { ok: false; error: string };

/**
 * UI-agnostic setup controller for the Telegram channel wizard.
 *
 * The controller owns token validation, temporary-listener handoff (stop the
 * old listener before discovery; start the replacement on confirm), and atomic
 * persistence. The TUI widget calls these typed methods and never touches the
 * stored token.
 */
export function createSetupController(options: SetupControllerOptions): SetupController {
  const projectRoot = options.projectRoot;
  const now = options.now ?? (() => new Date().toISOString());

  const existing = loadChannelConfig(projectRoot);
  let candidateToken: string | undefined;
  let keepToken = existing !== null;
  let token = existing?.botToken;
  let candidates = new Set<string>(existing?.allowedChatIds ?? []);
  let allowedChatIds = new Set<string>(existing?.allowedChatIds ?? []);
  let defaultChatId = existing?.defaultChatId;
  let liveBot: SetupBotSurface | undefined;

  function phase(): "token" | "discovery" | "review" {
    if (!tokenConfigured()) return "token";
    return defaultChatId === undefined ? "discovery" : "review";
  }

  function tokenConfigured(): boolean {
    return keepToken || candidateToken !== undefined;
  }

  function state(): SetupControllerState {
    return {
      phase: phase(),
      hasExistingToken: existing !== null,
      tokenConfigured: tokenConfigured(),
      maskedTokenExposed: false,
      candidates: [...candidates],
      allowedChatIds: [...allowedChatIds],
      defaultChatId,
    };
  }

  async function setToken(value: string): Promise<ControllerResult> {
    const trimmed = value.trim();
    if (trimmed.length === 0) return { ok: false, error: "Token is empty" };
    try {
      const bot = options.createBot(trimmed);
      await bot.getMe();
      candidateToken = trimmed;
      keepToken = false;
      token = trimmed;
      liveBot = bot;
      return { ok: true };
    } catch {
      return { ok: false, error: "Token is invalid" };
    }
  }

  function keepTokenValue(): ControllerResult {
    if (existing === null) return { ok: false, error: "No existing token to keep" };
    keepToken = true;
    token = existing.botToken;
    return { ok: true };
  }

  function acceptDiscoveredChat(chatId: string): void {
    candidates.add(chatId);
    // Existing chats remain allowed by default.
    allowedChatIds.add(chatId);
  }

  function setAllowedChat(chatId: string, allowed: boolean): void {
    if (allowed) {
      allowedChatIds.add(chatId);
    } else {
      allowedChatIds.delete(chatId);
      if (defaultChatId === chatId) defaultChatId = undefined;
    }
  }

  function setDefaultChat(chatId: string): ControllerResult {
    if (!allowedChatIds.has(chatId)) {
      return { ok: false, error: "Default chat must be in the allow-list" };
    }
    defaultChatId = chatId;
    return { ok: true };
  }

  /** Stop the old listener before discovery so no competing poller runs. */
  async function stopOldListener(): Promise<void> {
    if (existing !== null) {
      try {
        await options.createBot(existing.botToken).stop();
      } catch {
        // Best-effort; the listener may already be gone.
      }
    }
  }

  async function confirm(): Promise<ControllerResult> {
    if (token === undefined) return { ok: false, error: "No token configured" };
    if (defaultChatId === undefined) {
      return { ok: false, error: "No default chat selected" };
    }
    if (!allowedChatIds.has(defaultChatId)) {
      return { ok: false, error: "Default chat must be in the allow-list" };
    }
    // Stop the old listener before starting the replacement so no two pollers
    // ever run for the same token.
    await stopOldListener();
    const config: ChannelConfig = {
      botToken: token,
      defaultChatId,
      allowedChatIds: [...allowedChatIds],
      updatedAt: now(),
    };
    saveChannelConfig(projectRoot, config);
    // Start the replacement for the effective token (the validated new bot, or
    // a fresh bot for the kept token) after the old listener is stopped.
    const bot = liveBot ?? options.createBot(token);
    await bot.start();
    return { ok: true };
  }

  async function cancel(): Promise<void> {
    // Nothing is persisted until confirmation; the previous listener keeps
    // running from the preserved configuration.
  }

  return {
    getState: state,
    setToken,
    keepToken: keepTokenValue,
    acceptDiscoveredChat,
    setAllowedChat,
    setDefaultChat,
    confirm,
    cancel,
    stopOldListener,
  };
}

export interface SetupController {
  getState(): SetupControllerState;
  setToken(token: string): Promise<ControllerResult>;
  keepToken(): ControllerResult;
  acceptDiscoveredChat(chatId: string): void;
  setAllowedChat(chatId: string, allowed: boolean): void;
  setDefaultChat(chatId: string): ControllerResult;
  confirm(): Promise<ControllerResult>;
  cancel(): Promise<void>;
  stopOldListener(): Promise<void>;
}