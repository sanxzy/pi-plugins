/**
 * Telegram command content expansion for prompt templates and skills.
 *
 * Prompts and skills are files on disk (`SlashCommandInfo.sourceInfo.path`).
 * The bridge cannot rely on Pi's `sendUserMessage` to expand templates (it
 * runs with `expandPromptTemplates: false`), so discovered sources are expanded
 * here: read the file, strip frontmatter, substitute `$1`/`$@`/`${@:n}` args.
 * Skills also strip the `skill:` prefix from their command name.
 */

import { existsSync, readFileSync } from "node:fs";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";

/** Minimum shape of a Pi slash command source used for expansion. */
export interface TelegramExpandableSource {
  name: string;
  source?: string;
  sourceInfo?: { path?: string };
}

/** A discovered, expandable source ready for argument substitution. */
export interface TelegramExpansionTarget {
  name: string;
  /** The command name users type (prompt name or skill name, sanitized). */
  command: string;
  path: string;
}

/** Skip command names that are already handled by the extension bridge. */
export function telegramExpansionReservedNames(
  reserved: readonly string[],
): Set<string> {
  return new Set(reserved.map((name) => name.toLowerCase().replace(/^\/+/, "")));
}

/**
 * Discover prompt and skill sources that can be expanded from file contents.
 * Returns entries keyed by their sanitized Telegram command name.
 */
export function discoverTelegramExpansions(
  commands: readonly TelegramExpandableSource[],
  reserved: ReadonlySet<string> = new Set(),
): Map<string, TelegramExpansionTarget> {
  const targets = new Map<string, TelegramExpansionTarget>();
  for (const command of commands) {
    if (command.source !== "prompt" && command.source !== "skill") continue;
    const path = command.sourceInfo?.path;
    if (!path) continue;
    const rawName = command.source === "skill" && command.name.startsWith("skill:")
      ? command.name.slice("skill:".length)
      : command.name;
    const commandName = rawName
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32)
      .replace(/_+$/g, "");
    if (!commandName || reserved.has(commandName)) continue;
    targets.set(commandName, { name: command.name, command: commandName, path });
  }
  return targets;
}

/** Split a command arg string into tokens, honoring single/double quotes. */
export function parseTelegramTemplateArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const char of argsString) {
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === " " || char === "\t") {
      if (current) args.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

/** Substitute `$1`..`$n`, `${@:n}`/`${@:n:m}`, `$@`, and `$ARGUMENTS`. */
export function substituteTelegramTemplateArgs(
  content: string,
  args: readonly string[],
): string {
  let result = content.replace(/\$(\d+)/g, (_, num: string) => {
    const index = Number.parseInt(num, 10) - 1;
    return args[index] ?? "";
  });
  result = result.replace(
    /\$\{@:(\d+)(?::(\d+))?\}/g,
    (_, startValue: string, lengthValue: string | undefined) => {
      const start = Math.max(Number.parseInt(startValue, 10) - 1, 0);
      if (lengthValue) {
        const length = Number.parseInt(lengthValue, 10);
        return args.slice(start, start + length).join(" ");
      }
      return args.slice(start).join(" ");
    },
  );
  const allArgs = args.join(" ");
  return result.replace(/\$ARGUMENTS/g, allArgs).replace(/\$@/g, allArgs);
}

/** Read a template/skill file and strip its frontmatter. */
export function readTelegramExpansionFile(path: string): string {
  if (!existsSync(path)) return "";
  return stripFrontmatter(readFileSync(path, "utf-8"));
}

/** Template placeholders the bridge substitutes from user arguments. */
const TELEGRAM_TEMPLATE_PLACEHOLDER_PATTERN = /\$(\d+|\{@:|@|ARGUMENTS)/;

/**
 * Expand a discovered prompt/skill command with its arguments, or undefined
 * when the command is unknown. Relative skill paths are resolved against the
 * base directory when one is provided.
 *
 * When the template contains no arg placeholders (`$1`/`$@`/`${@:n}` and
 * friends), the user's arguments would otherwise be silently dropped. In that
 * case a non-empty argument list is appended to the expanded content as an
 * explicit context block so the request never loses its arguments. Templates
 * that do use placeholders keep their existing substitution behavior unchanged
 * (no duplication).
 */
export function expandTelegramCommand(
  targets: ReadonlyMap<string, TelegramExpansionTarget>,
  commandName: string,
  args: string,
  readFile: (path: string) => string = readTelegramExpansionFile,
): string | undefined {
  const target = targets.get(commandName);
  if (!target) return undefined;
  const content = readFile(target.path);
  if (!content) return undefined;
  const parsed = parseTelegramTemplateArgs(args);
  const substituted = substituteTelegramTemplateArgs(content, parsed);
  if (parsed.length > 0 && !TELEGRAM_TEMPLATE_PLACEHOLDER_PATTERN.test(content)) {
    return `${substituted}\n\n---\nUser request arguments: ${parsed.join(" ")}\n---`;
  }
  return substituted;
}