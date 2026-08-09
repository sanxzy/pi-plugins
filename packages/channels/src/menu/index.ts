import type { BotCommand } from "grammy/types";

export interface TelegramCommandInput {
  name: string;
  description?: string;
}

export type TelegramCommand = BotCommand;

export interface TelegramCommandMenuApi {
  setMyCommands?: (
    commands: readonly TelegramCommand[],
    other?: { scope?: { type: "default" } },
  ) => Promise<unknown>;
}

const MAX_COMMANDS = 100;
const MAX_COMMAND_LENGTH = 32;
const MAX_DESCRIPTION_LENGTH = 256;

/** Convert a Pi command list into Telegram's constrained command menu format. */
export function sanitizeTelegramCommands(inputs: readonly TelegramCommandInput[]): TelegramCommand[] {
  const commands: TelegramCommand[] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    const command = input.name
      .replaceAll("/", "")
      .replace(/[^a-z0-9_]/gi, "")
      .toLowerCase()
      .slice(0, MAX_COMMAND_LENGTH);
    if (command.length === 0 || seen.has(command)) continue;

    const description = (input.description ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, MAX_DESCRIPTION_LENGTH) || "Run Pi command";

    seen.add(command);
    commands.push({ command, description });
    if (commands.length >= MAX_COMMANDS) break;
  }

  return commands;
}

/** Push the current menu to Telegram's default (all-users) scope. */
export async function syncTelegramCommands(
  api: TelegramCommandMenuApi,
  inputs: readonly TelegramCommandInput[],
  warn: (message: string) => void = (message) => console.warn(message),
): Promise<void> {
  const setMyCommands = api.setMyCommands;
  if (setMyCommands === undefined) return;
  try {
    await setMyCommands(sanitizeTelegramCommands(inputs), { scope: { type: "default" } });
  } catch {
    // Menu availability must never prevent setup or polling from continuing.
    warn("Telegram command menu sync failed");
  }
}
