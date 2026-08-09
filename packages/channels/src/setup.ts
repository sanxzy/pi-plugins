import {
  readChannelConfig,
  validateChannelConfig,
  writeChannelConfig,
  writeLastConnection,
  type ChannelConfig,
  type StateResult,
} from "./state.ts";
import type { ChannelManager } from "./manager.ts";

/** UI-agnostic controller consumed structurally by @xzy-ai/tui. */
export interface TelegramSetupController {
  getInitialToken(): string;
  submitToken(token: string): Promise<{ ok: true; message?: string } | { ok: false; message: string }>;
  cancel(): Promise<void> | void;
}

export interface TelegramSetupControllerOptions {
  projectRoot: string;
  manager: ChannelManager;
  readConfig?: (projectRoot: string) => StateResult<ChannelConfig>;
  writeConfig?: (projectRoot: string, config: ChannelConfig) => StateResult<void>;
}

function safeFailure(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

/**
 * Create the setup boundary used by the dedicated TUI widget. Existing state
 * remains on disk until a candidate has connected successfully. Replacing a
 * listener always goes through the manager's stop-before-start handoff; a
 * failed candidate restores the prior listener and leaves prior config intact.
 */
export function createTelegramSetupController(
  options: TelegramSetupControllerOptions,
): TelegramSetupController {
  const readConfig = options.readConfig ?? readChannelConfig;
  const writeConfig = options.writeConfig ?? writeChannelConfig;
  let cancelled = false;

  return {
    // Never preload the stored credential into the widget. Rerunning setup is
    // supported without making the old token available to the presentation.
    getInitialToken: () => "",

    async submitToken(rawToken: string) {
      cancelled = false;
      const token = rawToken.trim();
      const current = readConfig(options.projectRoot);
      const previous = current.ok ? current.value : undefined;
      const candidate: ChannelConfig = {
        token,
        approvedUserIds: previous?.approvedUserIds ?? [],
        ...(previous?.defaultChatId === undefined ? {} : { defaultChatId: previous.defaultChatId }),
        ...(previous?.pendingPairings === undefined ? {} : { pendingPairings: previous.pendingPairings }),
      };

      const valid = validateChannelConfig(candidate);
      if (!valid.ok) return safeFailure(valid.message);

      const started = await options.manager.replace(valid.value);
      if (cancelled) {
        await restorePrevious(options, previous);
        return safeFailure("Telegram setup was cancelled");
      }
      if (!started.ok) {
        await restorePrevious(options, previous);
        return safeFailure(started.message);
      }

      const written = writeConfig(options.projectRoot, valid.value);
      if (!written.ok) {
        await restorePrevious(options, previous);
        return safeFailure("Telegram connected, but the configuration could not be saved");
      }

      const marker = writeLastConnection(options.projectRoot, {
        lastConnection: "tui",
        updatedAt: new Date().toISOString(),
      });
      if (!marker.ok) {
        // Restore the prior persisted config before restoring the prior listener.
        if (previous) writeConfig(options.projectRoot, previous);
        await restorePrevious(options, previous);
        return safeFailure("Telegram connected, but the connection marker could not be saved");
      }

      return { ok: true, message: "Telegram connection ready." };
    },

    async cancel() {
      cancelled = true;
      // The widget normally cancels before submission. If a submission is
      // already in flight, the next boundary stops the candidate safely.
    },
  };
}

async function restorePrevious(
  options: TelegramSetupControllerOptions,
  previous: ChannelConfig | undefined,
): Promise<void> {
  if (previous) {
    await options.manager.replace(previous);
  } else {
    await options.manager.stop();
  }
}
