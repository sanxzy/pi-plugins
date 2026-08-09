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

export interface TelegramInboundMessage {
  chatId: string;
  text?: string;
  caption?: string;
  photos?: TelegramPhoto[];
  documents?: TelegramDocument[];
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

function defaultDownload(token: string): NonNullable<InboundHandlerOptions["downloadFile"]> {
  return async (fileId: string, maxBytes: number): Promise<DownloadedTelegramFile> => {
    const metadataResponse = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
    if (!metadataResponse.ok) throw new Error("Telegram file metadata request failed");
    const metadata = (await metadataResponse.json()) as { ok?: boolean; result?: { file_path?: string } };
    const filePath = metadata.result?.file_path;
    if (!metadata.ok || !filePath) throw new Error("Telegram file metadata was incomplete");

    const response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    if (!response.ok) throw new Error("Telegram file download failed");
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > maxBytes) throw new Error("Telegram file exceeds the size limit");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("Telegram file exceeds the size limit");
    return { bytes, size: bytes.byteLength };
  };
}

function generatedUploadPath(projectRoot: string, sessionId: string, extension: "webp" | "bin"): string {
  const directory = uploadsDir(projectRoot, sessionId);
  mkdirSync(directory, { recursive: true });
  return join(directory, `telegram-${randomUUID()}.${extension}`);
}

function textPart(text: string): TextContent {
  return { type: "text", text };
}

function hasSupportedContent(message: TelegramInboundMessage): boolean {
  return Boolean(
    (message.text && message.text.length > 0) ||
    (message.caption && message.caption.length > 0) ||
    (message.photos && message.photos.length > 0) ||
    (message.documents && message.documents.length > 0),
  );
}

function failureText(label: string): string {
  return `${label} failed to process.`;
}

interface TypingLoop {
  active: number;
  timer: ReturnType<typeof setInterval> | undefined;
}

/**
 * Create an authorized Telegram inbound bridge. All media is completed before
 * exactly one follow-up is sent. Telegram messages are accepted only for the
 * supplied allow-list; accepted messages mark the connection as Telegram.
 */
export function createInboundHandler(options: InboundHandlerOptions) {
  const sharp: SharpAdapter = options.sharp ?? defaultSharpAdapter;
  const downloadFile: NonNullable<InboundHandlerOptions["downloadFile"]> =
    options.downloadFile ?? defaultDownload(options.token);
  const timerSet = options.setInterval ?? setInterval;
  const timerClear = options.clearInterval ?? clearInterval;
  const typing: TypingLoop = { active: 0, timer: undefined };

  const sendTypingSafely = (): void => {
    void options.sendTyping().catch(() => {
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

  async function processPhoto(photo: TelegramPhoto): Promise<{ content: ImageContent; upload: string }> {
    const downloaded = await downloadFile(photo.fileId, MAX_DOCUMENT_BYTES);
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

  async function processDocument(document: TelegramDocument): Promise<{ line: string; upload: string }> {
    if (document.fileSize !== undefined && document.fileSize > MAX_DOCUMENT_BYTES) {
      throw new Error("document exceeds 20 MB limit");
    }
    const downloaded = await downloadFile(document.fileId, MAX_DOCUMENT_BYTES);
    if (downloaded.size > MAX_DOCUMENT_BYTES) throw new Error("document exceeds 20 MB limit");
    const path = generatedUploadPath(options.projectRoot, options.sessionId, "bin");
    writeFileSync(path, downloaded.bytes, { mode: 0o600 });
    return { upload: path, line: `Telegram file saved at: ${isAbsolute(path) ? path : join(options.projectRoot, path)}` };
  }

  async function handleMessage(message: TelegramInboundMessage): Promise<InboundResult> {
    if (!options.allowedChatIds.includes(String(message.chatId))) {
      return { accepted: false, reason: "unauthorized", uploads: [] };
    }
    if (!hasSupportedContent(message)) {
      return { accepted: false, reason: "unsupported", uploads: [] };
    }

    typing.active += 1;
    startTyping();
    const uploads: string[] = [];
    try {
      await options.setTelegramMarker();
      const header = `Telegram message from chat ${message.chatId}:`;
      const body = message.text ?? message.caption;
      const images: ImageContent[] = [];
      const lines: string[] = [];
      const failures: string[] = [];

      if (body) lines.push(body);
      for (const photo of message.photos ?? []) {
        try {
          const result = await processPhoto(photo);
          images.push(result.content);
          uploads.push(result.upload);
        } catch {
          failures.push(failureText("Photo"));
        }
      }
      for (const document of message.documents ?? []) {
        try {
          const result = await processDocument(document);
          lines.push(result.line);
          uploads.push(result.upload);
        } catch {
          failures.push(failureText("Document"));
        }
      }

      const suffixLines = [...lines, ...failures];
      const marker = signature(message.chatId);
      let content: InboundContent;
      if (images.length > 0) {
        const parts: Array<TextContent | ImageContent> = [textPart(header)];
        if (images.length > 0) parts.push(...images);
        parts.push(textPart(`${suffixLines.length > 0 ? `\n${suffixLines.join("\n")}` : ""}${marker}`));
        content = parts;
      } else {
        const text = [header, ...suffixLines].join("\n") + marker;
        content = text;
      }
      await options.sendFollowUp(content, { deliverAs: "followUp" });
      return { accepted: true, uploads };
    } finally {
      typing.active -= 1;
      stopTypingIfIdle();
    }
  }

  return {
    handleMessage,
    async dispose(): Promise<void> {
      typing.active = 0;
      stopTypingIfIdle();
    },
  };
}
