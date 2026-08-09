import assert from "node:assert/strict";
import { test } from "node:test";
import {
  choiceCallbackData,
  isChoiceExpired,
  MAX_CHOICE_LENGTH,
  MAX_CHOICES,
  MIN_CHOICES,
  parseChoiceCallbackData,
  registerChoice,
  resolveChoice,
  validateChoices,
  type PendingChoice,
} from "../src/choices/index.ts";

test("validateChoices rejects fewer than 2 or more than 8 options", () => {
  assert.match(validateChoices([]) ?? "", /between 2 and 8/);
  assert.match(validateChoices([{ label: "a" }]) ?? "", /between 2 and 8/);
  assert.match(validateChoices(Array.from({ length: 9 }, (_, i) => ({ label: `o${i}` }))) ?? "", /between 2 and 8/);
  assert.equal(validateChoices([{ label: "a" }, { label: "b" }]), undefined);
});

test("validateChoices rejects oversized labels and values", () => {
  assert.match(validateChoices([{ label: "x".repeat(MAX_CHOICE_LENGTH + 1) }, { label: "b" }]) ?? "", /128/);
  assert.match(validateChoices([{ label: "a" }, { label: "b", value: "y".repeat(MAX_CHOICE_LENGTH + 1) }]) ?? "", /128/);
  assert.equal(validateChoices([{ label: "a" }, { label: "b", value: "ok" }]), undefined);
});

test("callback data is compact and round-trips", () => {
  for (const id of ["abc", "a1b2"]) {
    for (const index of [0, 1, 7]) {
      const data = choiceCallbackData(id, index);
      assert.ok(data.length <= 64, "callback data stays under 64 bytes");
      assert.deepEqual(parseChoiceCallbackData(data), { id, index });
    }
  }
  assert.equal(parseChoiceCallbackData("malformed"), undefined);
  assert.equal(parseChoiceCallbackData("id:not-a-number"), undefined);
});

test("choices are single-use and expire after the TTL", () => {
  const root = "project";
  const now = 1_000_000;
  const pending: PendingChoice = {
    id: "abc",
    question: "Pick one",
    options: [{ label: "Yes" }, { label: "No" }],
    defaultChatId: "42",
    expiresAt: now + 600_000,
    answered: false,
  };
  registerChoice(root, pending);
  assert.deepEqual(resolveChoice(root, "abc"), { ...pending, answered: false });
  assert.equal(isChoiceExpired(pending, now + 599_999), false);
  assert.equal(isChoiceExpired(pending, now + 600_001), true);
  const resolved = resolveChoice(root, "abc");
  assert.ok(resolved);
});

test("invalid index and unknown id resolve to undefined", () => {
  const root = "project";
  registerChoice(root, {
    id: "abc",
    question: "Pick",
    options: [{ label: "A" }, { label: "B" }],
    defaultChatId: "42",
    expiresAt: 1_000_000,
    answered: false,
  });
  assert.equal(resolveChoice(root, "nope"), undefined);
  assert.equal(resolveChoice(root, "abc", 2), undefined);
  assert.equal(resolveChoice(root, "abc", -1), undefined);
});