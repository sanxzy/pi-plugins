/**
 * Telegram command dispatch wiring for the commands package.
 *
 * Combines extension commands with explicit expanders (e.g. `/goal`) and
 * prompt/skill files discovered from `pi.getCommands()`. The bridge's
 * `expandCommand` seam uses this to dispatch recognized commands natively;
 * menu sync reuses the same source list, excluding extension commands that
 * have no native Telegram expander (they cannot be executed by the bridge).
 */

import {
  discoverTelegramExpansions,
  expandTelegramCommand,
  telegramExpansionReservedNames,
  type TelegramMenuCommandSource,
} from "@xzy-ai/channels";
import { expandTelegramGoalCommand } from "./goal-command.ts";

export interface TelegramCommandExpanderOptions {
  /** Read the current Pi command/prompt/skill catalog. */
  getCommands: () => readonly TelegramMenuCommandSource[];
  /** Extension commands dispatched natively from Telegram: name -> expander. */
  extensionExpanders?: Record<string, (args: string) => string>;
}

export interface TelegramCommandExpander {
  /** Expand a recognized command, or undefined when unknown. */
  expand(name: string, args: string): string | undefined;
  /** Menu sources for the Telegram bot command menu (dispatchable only). */
  menuSources(): TelegramMenuCommandSource[];
}

/** Create the expander and menu-source view over the Pi command catalog. */
export function createTelegramCommandExpander(
  options: TelegramCommandExpanderOptions,
): TelegramCommandExpander {
  const reserved = telegramExpansionReservedNames(Object.keys(options.extensionExpanders ?? {}));

  const expand = (name: string, args: string): string | undefined => {
    const explicit = options.extensionExpanders?.[name];
    if (explicit) return explicit(args);
    const targets = discoverTelegramExpansions(options.getCommands(), reserved);
    return expandTelegramCommand(targets, name, args);
  };

  const menuSources = (): TelegramMenuCommandSource[] => {
    const expanderNames = new Set(Object.keys(options.extensionExpanders ?? {}));
    return options
      .getCommands()
      .filter((command) => {
        if (command.source === "extension") {
          // Only extension commands with a native Telegram expander are shown.
          return expanderNames.has(command.name);
        }
        // Prompt/skill files whose name collides with an explicit extension
        // expander are excluded: the explicit expander wins at dispatch time.
        return !reserved.has(command.name);
      });
  };

  return { expand, menuSources };
}

/** Default expander: `/goal` plus discovered prompt/skill files. */
export function createDefaultTelegramCommandExpander(
  getCommands: () => readonly TelegramMenuCommandSource[],
): TelegramCommandExpander {
  return createTelegramCommandExpander({
    getCommands,
    extensionExpanders: { goal: expandTelegramGoalCommand },
  });
}
