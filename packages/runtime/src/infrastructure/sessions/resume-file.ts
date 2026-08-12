import { existsSync, readFileSync, writeFileSync } from "node:fs";

type SessionEntry = {
  type?: unknown;
  id?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  };
  [key: string]: unknown;
};

function isToolCallContent(item: unknown): boolean {
  return typeof item === "object" && item !== null && (item as { type?: unknown }).type === "toolCall";
}

/**
 * Remove tool calls from the tail of an interrupted assistant message.
 *
 * A resumed prompt is run through the normal prompt loop, not the continuation
 * loop. Leaving an unresolved assistant tool call in the existing transcript
 * would therefore cause the loop to execute that call again.
 */
function trimTrailingToolCalls(entries: SessionEntry[]): void {
  let messageIndex = entries.length - 1;
  while (messageIndex >= 0 && entries[messageIndex]?.type !== "message") {
    messageIndex -= 1;
  }
  if (messageIndex < 0) return;

  const entry = entries[messageIndex];
  const message = entry.message;
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return;

  const content = [...message.content];
  let changed = false;
  while (content.length > 0 && isToolCallContent(content[content.length - 1])) {
    content.pop();
    changed = true;
  }
  if (!changed) return;

  if (content.length === 0) {
    entries.splice(messageIndex, 1);
  } else {
    entries[messageIndex] = {
      ...entry,
      message: { ...message, content },
    };
  }
}

/**
 * Prepare an existing session transcript for an in-place resume.
 *
 * The job id and transcript path stay stable. Only the existing file is
 * rewritten when a trailing unresolved assistant tool call must be removed;
 * this prevents resume from creating duplicate jobs or accumulating copied
 * transcript files.
 */
export function prepareResumeSessionFile(source: string, jobId: string): string {
  if (!existsSync(source)) {
    throw new Error(`session file does not exist: ${source}`);
  }

  const entries = readFileSync(source, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEntry);

  const header = entries.find((entry) => entry.type === "session");
  if (!header) {
    throw new Error(`session file has no session header: ${source}`);
  }
  if (header.id !== jobId) {
    throw new Error(`session file id does not match job id: ${source}`);
  }

  const before = JSON.stringify(entries);
  trimTrailingToolCalls(entries);
  const after = JSON.stringify(entries);
  if (before !== after) {
    writeFileSync(source, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  }
  return source;
}
