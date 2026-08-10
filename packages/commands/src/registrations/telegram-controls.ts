import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  sendTelegramMessage,
  type TelegramCommand,
} from "@xzy-ai/channels";

export interface TelegramControlDispatchOptions {
  projectRoot: string;
  chatId: string;
  context: ExtensionContext;
  /** Injectable reply boundary for tests. */
  sendMessage?: (projectRoot: string, chatId: string, text: string) => Promise<unknown>;
}

const compactionByProject = new Set<string>();

/**
 * Dispatch Telegram-native controls without injecting them as model prompts.
 * Returns true when the command is owned by this control handler.
 */
export async function dispatchTelegramControl(
  command: TelegramCommand,
  options: TelegramControlDispatchOptions,
): Promise<boolean> {
  if (command.name !== "compact") return false;

  const send = options.sendMessage ?? (async (projectRoot, chatId, text) => {
    await sendTelegramMessage(projectRoot, chatId, text);
  });
  const reply = async (text: string): Promise<void> => {
    try {
      await send(options.projectRoot, options.chatId, text);
    } catch {
      // The control has already been handled. A reply failure must not turn it
      // into a model prompt or surface as an unhandled inbound rejection.
    }
  };

  if (
    !options.context.isIdle() ||
    options.context.hasPendingMessages() ||
    compactionByProject.has(options.projectRoot)
  ) {
    await reply("Cannot compact while Pi is busy or has pending messages. Wait for the current work to finish or send /abort first.");
    return true;
  }

  compactionByProject.add(options.projectRoot);
  await reply("🗜 Compaction started.");

  const finish = async (message: string): Promise<void> => {
    compactionByProject.delete(options.projectRoot);
    await reply(message);
  };

  try {
    options.context.compact({
      onComplete: () => {
        void finish("✅ Compaction completed.");
      },
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        void finish(`Compaction failed: ${message}`);
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finish(`Compaction failed: ${message}`);
  }

  return true;
}

/** Test isolation seam for the process-local compaction guard. */
export function clearTelegramControlState(): void {
  compactionByProject.clear();
}
