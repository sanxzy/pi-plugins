import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createInboundHandler,
  formatTelegramSignature,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  type DownloadedTelegramFile,
  type InboundContent,
  type TelegramInboundMessage,
} from "../src/inbound/index.ts";

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-channels-inbound-"));
}

function textMessage(overrides: Partial<TelegramInboundMessage> = {}): TelegramInboundMessage {
  return {
    chatId: "42",
    text: "hello from Telegram",
    ...overrides,
  };
}

function baseOptions(root: string, overrides: Record<string, unknown> = {}) {
  const followUps: Array<{ content: InboundContent; options: { deliverAs: "followUp" } }> = [];
  const markers: string[] = [];
  const typing: string[] = [];
  const options = {
    projectRoot: root,
    sessionId: "root-session",
    allowedChatIds: ["42"],
    defaultChatId: "42",
    token: "123456:SECRET-TOKEN",
    sendFollowUp: async (content: InboundContent, sendOptions: { deliverAs: "followUp" }) => {
      followUps.push({ content, options: sendOptions });
    },
    setTelegramMarker: () => {
      markers.push("telegram");
    },
    sendTyping: async () => {
      typing.push("typing");
    },
    sleep: async () => {},
    sharp: {
      encode: async () => ({ data: Buffer.from("webp"), info: { size: 4 } }),
    },
    ...overrides,
  };
  return { options, followUps, markers, typing };
}

test("formatTelegramSignature produces the exact origin block", () => {
  assert.equal(formatTelegramSignature("-100123"), "\n\n---\n[from:telegram:-100123]\n---");
});

test("unauthorized chats are ignored without marker, typing, download, or follow-up", async () => {
  const root = projectRoot();
  let downloads = 0;
  const { options, followUps, markers, typing } = baseOptions(root, {
    allowedChatIds: ["42"],
    downloadFile: async () => {
      downloads++;
      throw new Error("must not download");
    },
  });
  const handler = createInboundHandler(options);
  const result = await handler.handleMessage(textMessage({ chatId: "7", photos: [{ fileId: "photo" }] }));
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "unauthorized");
  assert.deepEqual(followUps, []);
  assert.deepEqual(markers, []);
  assert.deepEqual(typing, []);
  assert.equal(downloads, 0);
});

test("authorized text injects one follow-up with the chat-ID signature", async () => {
  const root = projectRoot();
  const { options, followUps, markers, typing } = baseOptions(root);
  const handler = createInboundHandler(options);
  const result = await handler.handleMessage(textMessage());
  assert.equal(result.accepted, true);
  assert.deepEqual(markers, ["telegram"]);
  assert.deepEqual(typing, ["typing"]);
  assert.equal(followUps.length, 1);
  assert.equal(followUps[0]?.options.deliverAs, "followUp");
  assert.equal(
    followUps[0]?.content,
    "Telegram message from chat 42:\nhello from Telegram\n\n---\n[from:telegram:42]\n---",
  );
});

test("unsupported-only messages are ignored without starting typing", async () => {
  const root = projectRoot();
  const { options, followUps, markers, typing } = baseOptions(root);
  const handler = createInboundHandler(options);
  const result = await handler.handleMessage(textMessage({ text: undefined, caption: undefined }));
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "unsupported");
  assert.deepEqual(followUps, []);
  assert.deepEqual(markers, []);
  assert.deepEqual(typing, []);
});

test("a photo is processed through the injectable Sharp adapter, saved as WebP, and attached as image content", async () => {
  const root = projectRoot();
  const source = Buffer.from("telegram-photo");
  const sharpCalls: Array<{ quality: number; longestEdge: number }> = [];
  const { options, followUps } = baseOptions(root, {
    downloadFile: async (): Promise<DownloadedTelegramFile> => ({ bytes: source, size: source.length }),
    sharp: {
      encode: async (_input: Buffer, request: { quality: number; longestEdge: number }) => {
        sharpCalls.push(request);
        return { data: Buffer.from("processed-webp"), info: { size: 14 } };
      },
    },
  });
  const handler = createInboundHandler(options);
  const result = await handler.handleMessage(textMessage({
    text: undefined,
    photos: [{ fileId: "photo-file", width: 1920, height: 1080 }],
  }));
  assert.equal(result.accepted, true);
  assert.ok(sharpCalls.length >= 1);
  assert.ok(sharpCalls[0]!.quality <= 80);
  assert.ok(sharpCalls[0]!.longestEdge > 0);
  assert.equal(followUps.length, 1);
  const content = followUps[0]?.content;
  assert.ok(Array.isArray(content));
  const image = content.find((part) => part.type === "image") as { type: "image"; data: string; mimeType: string } | undefined;
  assert.ok(image);
  assert.equal(image.mimeType, "image/webp");
  assert.equal(Buffer.from(image.data, "base64").toString(), "processed-webp");
  assert.ok(content.some((part) => part.type === "text" && part.text.includes("[from:telegram:42]")));
  const uploadPath = result.uploads[0];
  assert.ok(uploadPath?.endsWith(".webp"));
  assert.equal(existsSync(uploadPath!), true);
  assert.equal(statSync(uploadPath!).size, "processed-webp".length);
});

test("photo output must be strictly under 1 MB and retains the best fitting result", async () => {
  const root = projectRoot();
  const attempts: Array<{ quality: number; longestEdge: number }> = [];
  const { options, followUps } = baseOptions(root, {
    downloadFile: async (): Promise<DownloadedTelegramFile> => ({ bytes: Buffer.from("source"), size: 6 }),
    sharp: {
      encode: async (_input: Buffer, request: { quality: number; longestEdge: number }) => {
        attempts.push(request);
        const size = request.quality >= 70 ? MAX_IMAGE_BYTES + 1 : 500_000;
        return { data: Buffer.alloc(size), info: { size } };
      },
    },
  });
  const handler = createInboundHandler(options);
  const result = await handler.handleMessage(textMessage({
    text: undefined,
    photos: [{ fileId: "photo-file", width: 8000, height: 6000 }],
  }));
  assert.equal(result.accepted, true);
  assert.ok(attempts.length >= 2);
  assert.ok(result.uploads.length === 1);
  assert.ok(statSync(result.uploads[0]!).size < MAX_IMAGE_BYTES);
  assert.ok(followUps.length === 1);
});

test("a document uses a generated safe name, absolute session upload path, and path line", async () => {
  const root = projectRoot();
  const { options, followUps } = baseOptions(root, {
    downloadFile: async (): Promise<DownloadedTelegramFile> => ({ bytes: Buffer.from("document"), size: 8 }),
  });
  const handler = createInboundHandler(options);
  const result = await handler.handleMessage(textMessage({
    text: undefined,
    documents: [{ fileId: "document-file", fileSize: 8, fileName: "../../secret.txt" }],
  }));
  assert.equal(result.accepted, true);
  assert.equal(result.uploads.length, 1);
  assert.equal(result.uploads[0]?.startsWith(join(root, ".pi", "pi-code", "sessions", "root-session", "uploads")), true);
  assert.equal(result.uploads[0]?.includes("secret"), false);
  assert.equal(readFileSync(result.uploads[0]!, "utf-8"), "document");
  const content = followUps[0]?.content;
  assert.ok(typeof content === "string");
  assert.match(content, /Telegram file saved at:/);
  assert.match(content, /\[from:telegram:42\]/);
});

test("documents over 20 MB add a failure line while other successful items still deliver", async () => {
  const root = projectRoot();
  const { options, followUps } = baseOptions(root, {
    downloadFile: async (): Promise<DownloadedTelegramFile> => ({ bytes: Buffer.from("ok"), size: 2 }),
  });
  const handler = createInboundHandler(options);
  const result = await handler.handleMessage(textMessage({
    text: "caption",
    documents: [
      { fileId: "too-big", fileSize: MAX_DOCUMENT_BYTES + 1 },
      { fileId: "small", fileSize: 2 },
    ],
  }));
  assert.equal(result.accepted, true);
  assert.equal(result.uploads.length, 1);
  const content = followUps[0]?.content;
  assert.ok(typeof content === "string");
  assert.match(content, /caption/);
  assert.match(content, /failed/i);
  assert.match(content, /Telegram file saved at:/);
  assert.match(content, /\[from:telegram:42\]/);
});

test("typing is shared across concurrent accepted messages and stops after the last settles", async () => {
  const root = projectRoot();
  let releaseFirst: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const { options, typing } = baseOptions(root, {
    sendFollowUp: async () => {
      await gate;
    },
  });
  const handler = createInboundHandler(options);
  const first = handler.handleMessage(textMessage({ text: "first" }));
  const second = handler.handleMessage(textMessage({ text: "second" }));
  await Promise.resolve();
  assert.deepEqual(typing, ["typing"]);
  releaseFirst!();
  await Promise.all([first, second]);
  await handler.dispose();
  assert.equal(typing.length, 1);
});

test("typing send failures do not become unhandled rejections", async () => {
  const root = projectRoot();
  const { options, followUps } = baseOptions(root, {
    sendTyping: async () => {
      throw new Error("typing unavailable");
    },
  });
  const handler = createInboundHandler(options);
  const result = await handler.handleMessage(textMessage());
  assert.equal(result.accepted, true);
  assert.equal(followUps.length, 1);
  await handler.dispose();
});
