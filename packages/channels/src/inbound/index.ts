import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, isAbsolute } from "node:path";
import { uploadsDir } from "../state/index.ts";
import { defaultSharpAdapter, fitImageToBudget, MAX_IMAGE_BYTES, type SharpAdapter } from "./media.ts";

export { defaultSharpAdapter, fitImageToBudget, MAX_IMAGE_BYTES } from "./media.ts";
export type { SharpAdapter, SharpEncodeRequest, SharpEncodeResult } from "./media.ts";

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

export interface TelegramPhoto {
  fileId: string;
  width?: number;
  height?: number;
}

export interface TelegramDocument {
  fileId: string;
  fileSize?: number;
  fileName?: string;
}

/** A single ordered content item decoded from a Telegram update. */
export type TelegramContentItem =
  | { kind: "text"; text: string }
  | { kind: "photo"; fileId: string; width?: number; height?: number }
  | { kind: "document"; fileId: string; fileSize?: number; fileName?: string };

export interface NormalizedTelegramMessage {
  chatId: string;
  items: TelegramContentItem[];
}

/** The minimal grammY Bot surface the listener needs (injectable for tests). */
export interface TelegramListenerBot {
  on(event: "message", middleware: (context: unknown) => Promise<unknown>): void;
  api: {
    getFile(fileId: string): Promise<{ file_path?: string; file_size?: number }>;
    sendChatAction(chatId: string | number, action: "typing"): Promise<unknown>;
  };
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface TelegramRawPhoto {
  file_id: string;
  width?: number;
  height?: number;
}

interface TelegramRawDocument {
  file_id: string;
  file_size?: number;
  file_name?: string;
}

interface TelegramRawMessageContext {
  message?: {
    chat?: { id?: string | number };
    text?: string;
    caption?: string;
    photo?: TelegramRawPhoto[];
    document?: TelegramRawDocument;
  };
}

/**
 * Decode a grammY `message` context into ordered content items. Photos pick the
 * largest available size (last entry); never the smallest. Chat ids are always
 * strings, including negative group ids.
 */
export function normalizeTelegramMessage(context: unknown): NormalizedTelegramMessage | undefined {
  const message = (context as TelegramRawMessageContext)?.message;
  if (!message?.chat?.id) return undefined;
  const chatId = String(message.chat.id);
  const items: TelegramContentItem[] = [];
  if (message.caption) items.push({ kind: "text", text: message.caption });
  if (message.text) items.push({ kind: "text", text: message.text });
  if (message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1]!;
    items.push({ kind: "photo", fileId: largest.file_id, width: largest.width, height: largest.height });
  }
  if (message.document) {
    items.push({
      kind: "document",
      fileId: message.document.file_id,
      fileSize: message.document.file_size,
      fileName: message.document.file_name,
    });
  }
  if (items.length === 0) return undefined;
  return { chatId, items };
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export type InboundContent = string | Array<TextContent | ImageContent>;

export interface DownloadedTelegramFile {
  bytes: Buffer;
  size: number;
}

export interface InboundResult {
  accepted: boolean;
  reason?: "unauthorized" | "unsupported";
  uploads: string[];
}

export interface InboundHandlerOptions {
  projectRoot: string;
  sessionId: string;
  allowedChatIds: readonly string[];
  token: string;
  sendFollowUp(content: InboundContent, options: { deliverAs: "followUp" }): Promise<void>;
  setTelegramMarker(): void | Promise<void>;
  sendTyping(): Promise<void>;
  sharp?: SharpAdapter;
  downloadFile?: (fileId: string, maxBytes: number) => Promise<DownloadedTelegramFile>;
  /** Injecting the interval keeps lifecycle tests deterministic. */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

function signature(chatId: string): string {
  return `\n\n---\n[from:telegram:${chatId}]\n---`;
}

/** Exact origin marker appended to every Telegram-originated follow-up. */
export function formatTelegramSignature(chatId: string): string {
  return signature(chatId);
}

function generatedUploadPath(projectRoot: string, sessionId: string, extension: "webp" | "bin"): string {
  const directory = uploadsDir(projectRoot, sessionId);
  mkdirSync(directory, { recursive: true });
  return join(directory, `telegram-${randomUUID()}.${extension}`);
}

function textPart(text: string): TextContent {
  return { type: "text", text };
}

function failureText(label: string): string {
  return `${label} failed to process.`;
}

interface TypingLoop {
  active: number;
  timer: ReturnType<typeof setInterval> | undefined;
}

export interface TelegramListenerOptions {
  projectRoot: string;
  sessionId: string;
  allowedChatIds: readonly string[];
  token: string;
  bot: TelegramListenerBot;
  sendFollowUp(content: InboundContent, options: { deliverAs: "followUp" }): Promise<void>;
  setTelegramMarker(): void | Promise<void>;
  sharp?: SharpAdapter;
  /** Injectable grammY `getFile` result downloader (defaults to the Bot API URL). */
  downloadFile?: (fileId: string, maxBytes: number) => Promise<DownloadedTelegramFile>;
  /** Injectable fetch for the file download URL (seam for network-free tests). */
  fetchImpl?: typeof fetch;
  /** Injecting the interval keeps lifecycle tests deterministic. */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

/**
 * The authorized Telegram inbound path, wired to a grammY bot.
 *
 * Registers a `message` middleware on the supplied bot, normalizes each update
 * into an ordered content sequence, processes all media before exactly one
 * follow-up is injected, and drives a shared best-effort typing loop. Files are
 * retrieved through the grammY `getFile` API and downloaded from the resulting
 * URL; the token is never logged and Telegram-provided names are never used for
 * saved files.
 */
export function createTelegramListener(options: TelegramListenerOptions) {
  const sharp: SharpAdapter = options.sharp ?? defaultSharpAdapter;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timerSet = options.setInterval ?? setInterval;
  const timerClear = options.clearInterval ?? clearInterval;
  const typing: TypingLoop = { active: 0, timer: undefined };

  const downloadFile = async (fileId: string, maxBytes: number): Promise<DownloadedTelegramFile> => {
    const remote = await options.bot.api.getFile(fileId);
    const filePath = remote.file_path;
    if (!filePath) throw new Error("Telegram file metadata was incomplete");
    if (remote.file_size !== undefined && remote.file_size > maxBytes) {
      throw new Error("Telegram file exceeds the size limit");
    }
    // The download URL embeds the bot token; it is only ever used here and is
    // never exposed to logs, prompts, tool results, or Telegram messages.
    const response = await fetchImpl(`https://api.telegram.org/file/bot${options.token}/${filePath}`);
    if (!response.ok) throw new Error("Telegram file download failed");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("Telegram file exceeds the size limit");
    return { bytes, size: bytes.byteLength };
  };
  const download = options.downloadFile ?? downloadFile;

  const sendTypingSafely = (): void => {
    void options.bot.api.sendChatAction(options.allowedChatIds[0] ?? 0, "typing").catch(() => {
      // Typing is best-effort; an unavailable chat action must not reject input.
    });
  };

  const startTyping = (): void => {
    if (typing.timer !== undefined) return;
    sendTypingSafely();
    typing.timer = timerSet(() => {
      if (typing.active <= 0) return;
      sendTypingSafely();
    }, 4000);
  };

  const stopTypingIfIdle = (): void => {
    if (typing.active > 0 || typing.timer === undefined) return;
    timerClear(typing.timer);
    typing.timer = undefined;
  };

  async function processPhoto(photo: { fileId: string }): Promise<{ content: ImageContent; upload: string }> {
    const downloaded = await download(photo.fileId, MAX_DOCUMENT_BYTES);
    const encoded = await fitImageToBudget(downloaded.bytes, sharp);
    // The adapter contract measures the encoded output; retain a second guard
    // here so an adapter cannot accidentally write an over-budget image.
    if (encoded.info.size >= MAX_IMAGE_BYTES) {
      throw new Error("encoded photo exceeds image limit");
    }
    const path = generatedUploadPath(options.projectRoot, options.sessionId, "webp");
    writeFileSync(path, encoded.data, { mode: 0o600 });
    return {
      upload: path,
      content: {
        type: "image",
        data: encoded.data.toString("base64"),
        mimeType: "image/webp",
      },
    };
  }

  async function processDocument(document: { fileId: string; fileSize?: number }): Promise<{ line: string; upload: string }> {
    if (document.fileSize !== undefined && document.fileSize > MAX_DOCUMENT_BYTES) {
      throw new Error("document exceeds 20 MB limit");
    }
    const downloaded = await download(document.fileId, MAX_DOCUMENT_BYTES);
    if (downloaded.size > MAX_DOCUMENT_BYTES) throw new Error("document exceeds 20 MB limit");
    const path = generatedUploadPath(options.projectRoot, options.sessionId, "bin");
    writeFileSync(path, downloaded.bytes, { mode: 0o600 });
    return { upload: path, line: `Telegram file saved at: ${isAbsolute(path) ? path : join(options.projectRoot, path)}` };
  }

  async function handleMessage(context: unknown): Promise<void> {
    const normalized = normalizeTelegramMessage(context);
    if (normalized === undefined) return;
    if (!options.allowedChatIds.includes(normalized.chatId)) return;

    typing.active += 1;
    startTyping();
    try {
      await options.setTelegramMarker();
      const header = `Telegram message from chat ${normalized.chatId}:`;
      const images: ImageContent[] = [];
      const lines: string[] = [];
      const failures: string[] = [];

      // Process each ordered item in source order, keeping successful items on
      // failure so one bad file never drops the rest of the message.
      for (const item of normalized.items) {
        if (item.kind === "text") {
          lines.push(item.text);
        } else if (item.kind === "photo") {
          try {
            const result = await processPhoto(item);
            images.push(result.content);
            lines.push(`   (photo ${images.length})`);
          } catch {
            failures.push(failureText("Photo"));
          }
        } else {
          try {
            const result = await processDocument(item);
            lines.push(result.line);
          } catch {
            failures.push(failureText("Document"));
          }
        }
      }

      const marker = signature(normalized.chatId);
      let content: InboundContent;
      if (images.length > 0) {
        const parts: Array<TextContent | ImageContent> = [textPart(header)];
        parts.push(...images);
        parts.push(textPart(`${lines.length > 0 ? `\n${lines.join("\n")}` : ""}${failures.length > 0 ? `\n${failures.join("\n")}` : ""}${marker}`));
        content = parts;
      } else {
        const text = [header, ...lines, ...failures].join("\n") + marker;
        content = text;
      }
      await options.sendFollowUp(content, { deliverAs: "followUp" });
    } finally {
      typing.active -= 1;
      stopTypingIfIdle();
    }
  }

  options.bot.on("message", handleMessage);

  return {
    async start(): Promise<void> {
      await options.bot.start();
    },
    async stop(): Promise<void> {
      typing.active = 0;
      stopTypingIfIdle();
      await options.bot.stop();
    },
  };
}
