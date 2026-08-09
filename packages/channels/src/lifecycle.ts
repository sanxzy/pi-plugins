import type {
  ChannelConnectionState,
  ChannelManager,
} from "./manager.ts";
import { readChannelConfig } from "./state.ts";
import type { StateResult } from "./state.ts";

export interface TelegramChannelLifecycle {
  readonly projectRoot: string;
  readonly manager: ChannelManager;
  start(): Promise<StateResult<ChannelConnectionState>>;
  stop(): Promise<void>;
  state(): ChannelConnectionState;
}

export interface TelegramChannelLifecycleOptions {
  projectRoot: string;
  manager: ChannelManager;
  readConfig?: typeof readChannelConfig;
}

/**
 * Host-neutral lifecycle adapter. It reads project configuration, starts the
 * existing manager only when a valid config is present, and makes repeated
 * session-start/shutdown calls safe for reload and session replacement flows.
 */
export function createTelegramChannelLifecycle(
  options: TelegramChannelLifecycleOptions,
): TelegramChannelLifecycle {
  const readConfig = options.readConfig ?? readChannelConfig;

  const start = async (): Promise<StateResult<ChannelConnectionState>> => {
    const current = options.manager.state();
    if (current.status.kind === "ready" || current.status.kind === "starting") {
      return { ok: true, value: current };
    }

    const config = readConfig(options.projectRoot);
    if (!config.ok) {
      // No configuration yet is a normal no-op on session start; setup is what
      // creates one. Malformed or inaccessible state is surfaced to the host.
      if (config.code === "missing") return { ok: true, value: options.manager.state() };
      return config;
    }
    return options.manager.start(config.value);
  };

  return {
    projectRoot: options.projectRoot,
    manager: options.manager,
    start,
    stop: () => options.manager.stop(),
    state: () => options.manager.state(),
  };
}
