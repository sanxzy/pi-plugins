import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearTelegramChoiceState,
  consumeTelegramChoice,
  createTelegramChoice,
  type TelegramChoice,
} from "../src/index.ts";

function choice(): TelegramChoice {
  return { label: "Yes", value: "approved" };
}

test("choice state creates opaque indexed callback data and consumes once", () => {
  clearTelegramChoiceState();
  const created = createTelegramChoice({
    projectRoot: "/tmp/project",
    sessionId: "root",
    chatId: "777",
    senderId: "777",
    question: "Proceed?",
    choices: [choice(), { label: "No", value: "rejected" }],
    expiresAt: Date.now() + 60_000,
  });
  assert.match(created.callbackData[0]!, /^tc_[A-Za-z0-9_-]+_0$/);
  assert.equal(created.callbackData[0]!.includes("approved"), false);
  const consumed = consumeTelegramChoice(created.callbackData[0]!, {
    projectRoot: "/tmp/project",
    sessionId: "root",
    chatId: "777",
    senderId: "777",
  });
  assert.deepEqual(consumed?.value, "approved");
  assert.equal(consumeTelegramChoice(created.callbackData[0]!, {
    projectRoot: "/tmp/project", sessionId: "root", chatId: "777", senderId: "777",
  }), undefined);
  clearTelegramChoiceState();
});

test("concurrent duplicate callback deliveries consume a token exactly once", async () => {
  const created = createTelegramChoice({
    projectRoot: "project",
    sessionId: "root",
    chatId: "777",
    senderId: "111",
    question: "Proceed?",
    choices: [{ label: "Yes", value: "approved" }],
    expiresAt: Date.now() + 60_000,
  });
  const results = await Promise.all(Array.from({ length: 12 }, () => Promise.resolve().then(() => consumeTelegramChoice(created.callbackData[0]!, {
    projectRoot: "project", sessionId: "root", chatId: "777", senderId: "111",
  }))));
  assert.equal(results.filter((result) => result !== undefined).length, 1);
  assert.equal(results.filter((result) => result?.value === "approved").length, 1);
});

test("choice state rejects wrong target and expired callbacks", () => {
  clearTelegramChoiceState();
  const expired = createTelegramChoice({
    projectRoot: "/tmp/project", sessionId: "root", chatId: "777", senderId: "777",
    question: "Proceed?", choices: [choice()], expiresAt: Date.now() - 1,
  });
  assert.equal(consumeTelegramChoice(expired.callbackData[0]!, {
    projectRoot: "/tmp/project", sessionId: "root", chatId: "888", senderId: "888",
  }), undefined);
  clearTelegramChoiceState();
});
