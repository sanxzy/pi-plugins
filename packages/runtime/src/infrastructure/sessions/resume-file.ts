import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionDir } from "../../shared/paths.ts";

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
 * loop. Leaving an unresolved assistant tool call in the copied transcript
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
 * Copy a stored session transcript for a new job and make it resumable.
 *
 * The source is never modified. The copied session receives the new job id in
 * its header, and a trailing unresolved assistant tool call is removed before
 * the child session manager reopens it.
 *
 * The copy lives under the new job's parent live-session folder
 * (`sessions/<parent-session-id>/`), keyed by the resume job id so the
 * reopened child's session id (== resume job id) matches its storage folder.
 */
export function prepareResumeSessionFile(
  source: string,
  newJobId: string,
  cwd: string,
  parentSessionId?: string,
): string {
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
  header.id = newJobId;
  trimTrailingToolCalls(entries);

  if (!parentSessionId) {
    throw new Error("A resume transcript requires its parent session id");
  }
  // Every transcript belongs to the folder owned by the live session that
  // spawned it. There is no flat fallback: storage is session-scoped only.
  const directory = sessionDir(cwd, parentSessionId);
  mkdirSync(directory, { recursive: true });
  const destination = join(directory, `${newJobId}.jsonl`);
  writeFileSync(destination, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return destination;
}
