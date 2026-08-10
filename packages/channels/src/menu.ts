/**
 * Pure Telegram bot-command menu helpers.
 *
 * Channels never imports Pi internals; callers supply `SlashCommandInfo`-shaped
 * records (extension commands, prompt templates, skills) and this module
 * sanitizes them into Bot API `BotCommand` entries, dedupes collisions, and
 * caps the list to Telegram's 100-entry menu limit.
 */

/** Minimum shape of a Pi slash command used for menu population. */
export interface TelegramMenuCommandSource {
  name: string;
  description?: string;
  /** "extension" | "prompt" | "skill" */
  source?: string;
}

/** Telegram Bot API `BotCommand` entry. */
export interface TelegramBotCommand {
  command: string;
  description: string;
}

export const TELEGRAM_MENU_COMMAND_PATTERN = /^[a-z0-9_]{1,32}$/;
export const TELEGRAM_MENU_MAX_COMMANDS = 100;
export const TELEGRAM_MENU_MAX_DESCRIPTION = 256;

/**
 * Sanitize a Pi slash-command name into a Bot API command name: lowercase,
 * keep `[a-z0-9_]`, collapse underscores, truncate 32, strip trailing
 * underscores. `skill:name` becomes `name`. Returns undefined when nothing
 * valid remains.
 */
export function sanitizeTelegramCommandName(name: string): string | undefined {
  const base = name.startsWith("skill:") ? name.slice("skill:".length) : name;
  const sanitized = base
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32)
    .replace(/_+$/g, "");
  return TELEGRAM_MENU_COMMAND_PATTERN.test(sanitized) ? sanitized : undefined;
}

/** Clean and truncate a description to Telegram's 256-char limit. */
export function sanitizeTelegramCommandDescription(description: string | undefined): string {
  if (!description) return "";
  const cleaned = description.replace(/\s+/g, " ").trim();
  return cleaned.slice(0, TELEGRAM_MENU_MAX_DESCRIPTION);
}

/**
 * Build the capped, deduped bot command menu. Extension commands keep their
 * names; prompt templates are mapped through the same sanitizer (a `-` becomes
 * `_`); skills drop the `skill:` prefix. First occurrence wins on collisions.
 */
export function buildTelegramBotCommands(
  commands: readonly TelegramMenuCommandSource[],
): TelegramBotCommand[] {
  const seen = new Set<string>();
  const menu: TelegramBotCommand[] = [];
  for (const command of commands) {
    const name = sanitizeTelegramCommandName(command.name);
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const description = sanitizeTelegramCommandDescription(command.description);
    if (!description) continue;
    menu.push({ command: name, description });
    if (menu.length >= TELEGRAM_MENU_MAX_COMMANDS) break;
  }
  return menu;
}
