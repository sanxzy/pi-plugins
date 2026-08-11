import assert from "node:assert/strict";
import { test } from "node:test";
import { createChannelChatRegistry } from "../src/chat.ts";

test("channel chat registry normalizes ids and replaces adapters deterministically", () => {
  const registry = createChannelChatRegistry();
  const first = { id: " Telegram ", label: "Telegram" } as never;
  const replacement = { id: "telegram", label: "Replacement" } as never;
  registry.register(first);
  assert.equal(registry.get("TELEGRAM"), first);
  registry.register(replacement);
  assert.equal(registry.get("telegram"), replacement);
  assert.deepEqual(registry.list(), [replacement]);
  registry.unregister(" TELEGRAM ");
  assert.equal(registry.get("telegram"), undefined);
});

test("channel chat registry rejects empty adapter ids", () => {
  const registry = createChannelChatRegistry();
  assert.throws(() => registry.register({ id: "  " } as never), /must not be empty/);
});
