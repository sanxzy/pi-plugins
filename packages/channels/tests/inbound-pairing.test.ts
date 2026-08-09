import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTelegramInbound,
  type ChannelConfig,
  type TelegramInboundListener,
} from "../src/index.ts";

const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWX";

function privateText(updateId: number, fromId: number, text: string): unknown {
  return { update_id: updateId, message: { chat: { id: 777, type: "private" }, from: { id: fromId }, text } };
}

interface Harness {
  listener: TelegramInboundListener;
  config: ChannelConfig;
  accepted: string[];
  challenges: Array<{ chatId: string; text: string }>;
  errors: unknown[];
}

function makeHarness(approved: string[] = []): Harness {
  const config: ChannelConfig = { token: TOKEN, approvedUserIds: approved };
  const accepted: string[] = [];
  const challenges: Array<{ chatId: string; text: string }> = [];
  const errors: unknown[] = [];
  const listener = createTelegramInbound({
    approvedUserIds: approved,
    readConfig: () => ({ ok: true, value: config }),
    writeConfig: (next) => {
      config.token = next.token;
      config.approvedUserIds = [...next.approvedUserIds];
      config.pendingPairings = next.pendingPairings?.map((p) => ({ ...p }));
      return { ok: true, value: undefined };
    },
    onChallenge: async (_context, chatId, text) => {
      challenges.push({ chatId, text });
    },
    onError: (error) => errors.push(error),
    onAccepted: async (updateId, chatId, text) => {
      accepted.push(text);
      assert.equal(chatId, "777");
      assert.equal(updateId > 0, true);
    },
  });
  return { listener, config, accepted, challenges, errors };
}

test("an unauthorized private DM creates a challenge and is never delivered", async () => {
  const h = makeHarness();
  await h.listener.handle(privateText(1, 111, "hello"));
  assert.deepEqual(h.accepted, [], "unauthorized text never enters the parent");
  assert.equal(h.challenges.length, 1, "one challenge is sent");
  assert.match(h.challenges[0]!.text, /Pairing code: [A-Z2-9]{8}/);
  assert.equal(h.config.pendingPairings?.length, 1);
  assert.equal(h.config.approvedUserIds.length, 0);
  h.listener.stop();
});

test("repeated DMs reuse the request and send no second challenge", async () => {
  const h = makeHarness();
  await h.listener.handle(privateText(1, 111, "one"));
  await h.listener.handle(privateText(2, 111, "two"));
  assert.equal(h.challenges.length, 1, "only the first unauthorized DM gets a challenge");
  assert.equal(h.config.pendingPairings?.length, 1, "the same request is reused");
  h.listener.stop();
});

test("after approval a later DM is accepted; the challenged message is not replayed", async () => {
  const h = makeHarness();
  await h.listener.handle(privateText(1, 111, "challenged"));
  assert.equal(h.accepted.length, 0);
  // The operator approves the pending request.
  h.config.approvedUserIds = ["111"];
  h.listener.setApprovedUserIds(["111"]);
  await h.listener.handle(privateText(2, 111, "later"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(h.accepted, ["later"], "only the post-approval message is delivered");
  assert.equal(h.challenges.length, 1, "no challenge is replayed");
  h.listener.stop();
});