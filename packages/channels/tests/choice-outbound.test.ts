import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CHOICE_TTL_MS,
  resolveChoice,
  resetChoices,
} from "../src/choices/index.ts";
import { sendTelegramChoice, type ChoiceBotSurface } from "../src/outbound/choice.ts";
import { sendChoiceQuery } from "../src/outbound/send.ts";
import { saveChannelConfig } from "../src/state/index.ts";

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-channels-choice-outbound-"));
}

function configure(root: string): void {
  saveChannelConfig(root, {
    botToken: "123456:SECRET",
    defaultChatId: "42",
    allowedChatIds: ["42"],
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

test("choice query chunks long questions and attaches keyboard only to final chunk", async () => {
  const calls: Array<{ text: string; other?: Record<string, unknown> }> = [];
  await sendChoiceQuery(
    {
      sendMessage: async (_chatId, text, other) => {
        calls.push({ text, other });
        return { message_id: calls.length };
      },
    },
    "42",
    "x".repeat(4097),
    [{ text: "A", callback_data: "pc:id:0" }, { text: "B", callback_data: "pc:id:1" }],
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.other, undefined);
  assert.deepEqual(calls[1]?.other, {
    reply_markup: {
      inline_keyboard: [[
        { text: "A", callback_data: "pc:id:0" },
        { text: "B", callback_data: "pc:id:1" },
      ]],
    },
  });
});

test("choice sender registers pending state, sends signed answer via follow-up, and auto-expires", async () => {
  resetChoices();
  const root = projectRoot();
  configure(root);
  let now = 1000;
  let expiryCallback: (() => void) | undefined;
  let capturedCallbackData = "";
  const followUps: string[] = [];
  const bot: ChoiceBotSurface = {
    api: {
      sendMessage: async (_chatId, _text, other) => {
        const keyboard = other?.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined;
        capturedCallbackData = keyboard?.inline_keyboard?.[0]?.[0]?.callback_data ?? "";
        return { message_id: 9 };
      },
      answerCallbackQuery: async () => {},
      editMessageReplyMarkup: async () => {},
    },
  };
  const result = await sendTelegramChoice(root, "Full question", [{ label: "A", value: "alpha" }, { label: "B" }], {
    createBot: () => bot,
    now: () => now,
    setTimeout: (callback: () => void) => {
      expiryCallback = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: () => {},
    sendFollowUp: async (content) => {
      followUps.push(content);
    },
  });
  assert.equal(result.ok, true);

  // Recover the pending id from the sent callback data and verify it is registered.
  const id = capturedCallbackData.split(":")[1];
  assert.ok(id);
  const pending = resolveChoice(root, id!);
  assert.ok(pending);
  assert.equal(pending!.defaultChatId, "42");
  assert.equal(pending!.answered, false);
  assert.equal(pending!.expiresAt, now + CHOICE_TTL_MS);

  // No follow-up is injected until a tap arrives.
  assert.equal(followUps.length, 0);

  // A tap from the default chat answers, disables the keyboard, and injects a
  // signed contextual follow-up carrying the full question and selected value.
  await pending!.onAnswer!({ label: "A", value: "alpha" }, {
    answer: async () => {},
    removeKeyboard: async () => {},
    beginTyping: () => {},
    endTyping: () => {},
  });
  assert.equal(followUps.length, 1);
  assert.equal(
    followUps[0],
    "Based on your question: Full question\nAnswer: alpha\n\n---\n[from:telegram:42]\n---",
  );

  // Auto-expiry drops the pending state after the TTL.
  now += CHOICE_TTL_MS;
  expiryCallback!();
  assert.equal(resolveChoice(root, id!), undefined);
});

test("choice sender drops pending state when the initial send fails", async () => {
  resetChoices();
  const root = projectRoot();
  configure(root);
  const bot: ChoiceBotSurface = {
    api: {
      sendMessage: async () => {
        throw new Error("chat not found");
      },
      answerCallbackQuery: async () => {},
      editMessageReplyMarkup: async () => {},
    },
  };
  const result = await sendTelegramChoice(root, "Question", [{ label: "A" }, { label: "B" }], {
    createBot: () => bot,
    now: () => 1000,
    setTimeout: (_callback: () => void) => 1 as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => {},
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /chat not found/);
});