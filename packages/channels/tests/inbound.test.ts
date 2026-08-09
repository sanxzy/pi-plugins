import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createTelegramListener,
  formatTelegramSignature,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  normalizeTelegramMessage,
  type DownloadedTelegramFile,
  type InboundContent,
  type TelegramListenerBot,
} from "../src/inbound/index.ts";

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-channels-inbound-"));
}

function fakeBot() {
  let handler: ((context: unknown) => Promise<unknown>) | undefined;
  const calls: string[] = [];
  const bot: TelegramListenerBot = {
    on: (_event, next) => {
      handler = next;
    },
    api: {
      getFile: async (fileId) => {
        calls.push(`getFile:${fileId}`);
        return { file_path: "documents/file.bin", file_size: 8 };
      },
      sendChatAction: async (chatId, action) => {
        calls.push(`typing:${chatId}:${action}`);
      },
    },
    start: async () => {
      calls.push("start");
    },
    stop: async () => {
      calls.push("stop");
    },
  };
  return { bot, calls, getHandler: () => handler! };
}

function messageContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message: { chat: { id: 42 }, text: "hello from Telegram", ...overrides },
  };
}

function baseOptions(root: string, overrides: Record<string, unknown> = {}) {
  const fake = fakeBot();
  const followUps: Array<{ content: InboundContent; options: { deliverAs: "followUp" } }> = [];
  const markers: string[] = [];
  const options = {
    projectRoot: root,
    sessionId: "root-session",
    allowedChatIds: ["42"],
    token: "123456:SECRET-TOKEN",
    bot: fake.bot,
    sendFollowUp: async (content: InboundContent, sendOptions: { deliverAs: "followUp" }) => {
      followUps.push({ content, options: sendOptions });
    },
    setTelegramMarker: () => {
      markers.push("telegram");
    },
    sharp: {
      encode: async () => ({ data: Buffer.from("webp"), info: { size: 4 } }),
    },
    ...overrides,
  };
  return { options, followUps, markers, fake, ...(overrides.fake ? {} : {}) };
}

test("formatTelegramSignature produces the exact origin block", () => {
  assert.equal(formatTelegramSignature("-100123"), "\n\n---\n[from:telegram:-100123]\n---");
});

test("normalizeTelegramMessage decodes ordered items and string chat ids", () => {
  const normalized = normalizeTelegramMessage({
    message: {
      chat: { id: -100123 },
      caption: "caption",
      photo: [
        { file_id: "small", width: 100, height: 100 },
        { file_id: "large", width: 1000, height: 800 },
      ],
    },
  });
  assert.equal(normalized?.chatId, "-100123");
  assert.deepEqual(normalized?.items, [
    { kind: "text", text: "caption" },
    { kind: "photo", fileId: "large", width: 1000, height: 800 },
  ]);
});

test("unauthorized chats are ignored without marker, typing, download, or follow-up", async () => {
  const root = projectRoot();
  const { options, followUps, markers, fake } = baseOptions(root);
  const listener = createTelegramListener(options);
  await listener.start();
  await fake.getHandler()({ message: { chat: { id: 7 }, text: "hi" } });
  assert.deepEqual(followUps, []);
  assert.deepEqual(markers, []);
  assert.equal(fake.calls.includes("typing:7:typing"), false);
  assert.equal(fake.calls.includes("getFile"), false);
  await listener.stop();
});

test("authorized text injects one follow-up with the chat-ID signature", async () => {
  const root = projectRoot();
  const { options, followUps, markers, fake } = baseOptions(root);
  const listener = createTelegramListener(options);
  await listener.start();
  await fake.getHandler()(messageContext());
  assert.deepEqual(markers, ["telegram"]);
  assert.equal(fake.calls.includes("typing:42:typing"), true);
  assert.equal(followUps.length, 1);
  assert.equal(followUps[0]?.options.deliverAs, "followUp");
  assert.equal(
    followUps[0]?.content,
    "Telegram message from chat 42:\nhello from Telegram\n\n---\n[from:telegram:42]\n---",
  );
  await listener.stop();
});

test("slash commands are injected literally without local dispatch", async () => {
  const root = projectRoot();
  const { options, followUps, fake } = baseOptions(root);
  const listener = createTelegramListener(options);
  await listener.start();
  await fake.getHandler()(messageContext({ text: "/status unknown" }));
  assert.equal(followUps.length, 1);
  assert.equal(
    followUps[0]?.content,
    "Telegram message from chat 42:\n/status unknown\n\n---\n[from:telegram:42]\n---",
  );
  await listener.stop();
});

test("unsupported-only messages are ignored without starting typing", async () => {
  const root = projectRoot();
  const { options, followUps, markers, fake } = baseOptions(root);
  const listener = createTelegramListener(options);
  await listener.start();
  await fake.getHandler()({ message: { chat: { id: 42 }, sticker: {} } });
  assert.deepEqual(followUps, []);
  assert.deepEqual(markers, []);
  assert.equal(fake.calls.includes("typing:42:typing"), false);
  await listener.stop();
});

test("a photo is processed through the injectable Sharp adapter, saved as WebP, and attached as image content", async () => {
  const root = projectRoot();
  const source = Buffer.from("telegram-photo");
  const sharpCalls: Array<{ quality: number; longestEdge: number }> = [];
  const { options, followUps, fake } = baseOptions(root, {
    downloadFile: async (): Promise<DownloadedTelegramFile> => ({ bytes: source, size: source.length }),
    sharp: {
      encode: async (_input: Buffer, request: { quality: number; longestEdge: number }) => {
        sharpCalls.push(request);
        return { data: Buffer.from("processed-webp"), info: { size: 14 } };
      },
    },
  });
  const listener = createTelegramListener(options);
  await listener.start();
  await fake.getHandler()({ message: { chat: { id: 42 }, photo: [{ file_id: "photo-file", width: 1920, height: 1080 }] } });
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
  await listener.stop();
});

test("photo output must be strictly under 1 MB and retains the best fitting result", async () => {
  const root = projectRoot();
  const attempts: Array<{ quality: number; longestEdge: number }> = [];
  const { options, followUps, fake } = baseOptions(root, {
    downloadFile: async (): Promise<DownloadedTelegramFile> => ({ bytes: Buffer.from("source"), size: 6 }),
    sharp: {
      encode: async (_input: Buffer, request: { quality: number; longestEdge: number }) => {
        attempts.push(request);
        const size = request.quality >= 70 ? MAX_IMAGE_BYTES + 1 : 500_000;
        return { data: Buffer.alloc(size), info: { size } };
      },
    },
  });
  const listener = createTelegramListener(options);
  await listener.start();
  await fake.getHandler()({ message: { chat: { id: 42 }, photo: [{ file_id: "photo-file", width: 8000, height: 6000 }] } });
  assert.ok(attempts.length >= 2);
  assert.equal(followUps.length, 1);
  const content = followUps[0]?.content;
  assert.ok(Array.isArray(content));
  const image = content.find((part) => part.type === "image") as { type: "image"; data: string; mimeType: string } | undefined;
  assert.ok(image);
  assert.equal(Buffer.from(image.data, "base64").byteLength, 500_000);
  await listener.stop();
});

test("a document uses a generated safe name, absolute session upload path, and path line", async () => {
  const root = projectRoot();
  const { options, followUps, fake } = baseOptions(root, {
    downloadFile: async (): Promise<DownloadedTelegramFile> => ({ bytes: Buffer.from("document"), size: 8 }),
  });
  const listener = createTelegramListener(options);
  await listener.start();
  await fake.getHandler()({
    message: { chat: { id: 42 }, document: { file_id: "document-file", file_size: 8, file_name: "../../secret.txt" } },
  });
  const content = followUps[0]?.content;
  assert.ok(typeof content === "string");
  assert.match(content, /Telegram file saved at:/);
  const uploadPath = content.match(/saved at: (.+)/)?.[1] ?? "";
  assert.equal(uploadPath.startsWith(join(root, ".pi", "pi-code", "sessions", "root-session", "uploads")), true);
  assert.equal(uploadPath.includes("secret"), false);
  assert.equal(uploadPath.endsWith(".bin"), true);
  assert.equal(readFileSync(uploadPath, "utf-8"), "document");
  assert.match(content, /\[from:telegram:42\]/);
  await listener.stop();
});

test("documents over 20 MB add a failure line while other successful items still deliver", async () => {
  const root = projectRoot();
  const { options, followUps, fake } = baseOptions(root, {
    downloadFile: async (): Promise<DownloadedTelegramFile> => ({ bytes: Buffer.from("ok"), size: 2 }),
  });
  const listener = createTelegramListener(options);
  await listener.start();
  await fake.getHandler()({
    message: {
      chat: { id: 42 },
      caption: "caption",
      document: { file_id: "too-big", file_size: MAX_DOCUMENT_BYTES + 1 },
    },
  });
  const content = followUps[0]?.content;
  assert.ok(typeof content === "string");
  assert.match(content, /caption/);
  assert.match(content, /failed to process/);
  assert.match(content, /\[from:telegram:42\]/);
  assert.equal(existsSync(uploadPathFrom(content)), false);
  await listener.stop();

  function uploadPathFrom(text: string): string {
    const match = text.match(/saved at: (.+)/);
    return match ? match[1]! : "";
  }
});

test("typing is shared across concurrent accepted messages and stops after the last settles", async () => {
  const root = projectRoot();
  let releaseFirst: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const { options, fake } = baseOptions(root, {
    sendFollowUp: async () => {
      await gate;
    },
  });
  const listener = createTelegramListener(options);
  await listener.start();
  const first = fake.getHandler()(messageContext({ text: "first" }));
  const second = fake.getHandler()(messageContext({ text: "second" }));
  await Promise.resolve();
  assert.equal(fake.calls.filter((call) => call.startsWith("typing:")).length, 1);
  releaseFirst!();
  await Promise.all([first, second]);
  await listener.stop();
  assert.equal(fake.calls.filter((call) => call.startsWith("typing:")).length, 1);
});

test("typing send failures do not become unhandled rejections", async () => {
  const root = projectRoot();
  const { options, followUps, fake } = baseOptions(root);
  options.bot.api.sendChatAction = async () => {
    throw new Error("typing unavailable");
  };
  const listener = createTelegramListener(options);
  await listener.start();
  await fake.getHandler()(messageContext());
  assert.equal(followUps.length, 1);
  await listener.stop();
});

test("the listener downloads through the grammY getFile seam and never exposes Telegram names", async () => {
  const root = projectRoot();
  let fetchedUrl = "";
  const { options, fake } = baseOptions(root, {
    fetchImpl: async (input: string | URL | Request) => {
      fetchedUrl = String(input);
      return {
        ok: true,
        headers: { get: () => "8" },
        arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
      } as unknown as Response;
    },
  });
  const listener = createTelegramListener(options);
  await listener.start();
  await fake.getHandler()({
    message: { chat: { id: 42 }, document: { file_id: "doc", file_size: 8, file_name: "unsafe.txt" } },
  });
  assert.equal(fake.calls.includes("getFile:doc"), true);
  assert.match(fetchedUrl, /api\.telegram\.org\/file\/bot123456:SECRET-TOKEN\/documents\/file\.bin/);
  await listener.stop();
});
