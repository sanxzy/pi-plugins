import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { TUI } from "@earendil-works/pi-tui";
import { TelegramChannelSetup, type TelegramSetupController, type TelegramSetupResult } from "../src/index.ts";
import { textTheme } from "./test-theme.ts";

function fakeTui(): TUI {
  return { terminal: { rows: 24 }, requestRender: () => {} } as unknown as TUI;
}

function controller(overrides: Partial<TelegramSetupController> = {}): TelegramSetupController {
  const state: {
    phase: "token" | "discovery" | "review";
    hasExistingToken: boolean;
    tokenConfigured: boolean;
    maskedTokenExposed: false;
    candidates: string[];
    allowedChatIds: string[];
    defaultChatId: string | undefined;
  } = {
    phase: "token",
    hasExistingToken: false,
    tokenConfigured: false,
    maskedTokenExposed: false,
    candidates: [],
    allowedChatIds: [],
    defaultChatId: undefined,
  };
  return {
    getState: () => state,
    setToken: async () => {
      state.tokenConfigured = true;
      state.phase = "discovery";
      return { ok: true };
    },
    keepToken: () => {
      state.tokenConfigured = true;
      state.phase = "discovery";
      return { ok: true };
    },
    acceptDiscoveredChat: (chatId) => {
      if (!state.candidates.includes(chatId)) state.candidates.push(chatId);
    },
    setAllowedChat: (chatId, allowed) => {
      state.allowedChatIds = allowed
        ? [...new Set([...state.allowedChatIds, chatId])]
        : state.allowedChatIds.filter((id) => id !== chatId);
    },
    setDefaultChat: (chatId) => {
      if (!state.allowedChatIds.includes(chatId)) return { ok: false, error: "Default chat must be allowed" };
      state.defaultChatId = chatId;
      state.phase = "review";
      return { ok: true };
    },
    confirm: async () => ({ ok: true }),
    cancel: async () => {},
    stopOldListener: async () => {},
    ...overrides,
  };
}

function makeWidget(
  c: TelegramSetupController = controller(),
  done: (result: TelegramSetupResult) => void = () => {},
): TelegramChannelSetup {
  return new TelegramChannelSetup({ tui: fakeTui(), controller: c, theme: textTheme, done });
}

function plain(widget: TelegramChannelSetup): string {
  return stripVTControlCharacters(widget.render(70).join("\n"));
}

test("initial setup renders token entry and never renders a stored token", () => {
  const widget = makeWidget();
  const rendered = plain(widget);
  assert.match(rendered, /Telegram channel setup/);
  assert.match(rendered, /Enter the bot token/);
  assert.doesNotMatch(rendered, /existing token/);
});

test("existing setup renders masked keep/replace choices without token value", () => {
  const widget = makeWidget(
    controller({
      getState: () => ({
        phase: "token",
        hasExistingToken: true,
        tokenConfigured: true,
        maskedTokenExposed: false,
        candidates: [],
        allowedChatIds: [],
        defaultChatId: undefined,
      }),
    }),
  );
  const rendered = plain(widget);
  assert.match(rendered, /existing bot token is configured/);
  assert.match(rendered, /Keep existing token/);
  assert.match(rendered, /Replace token/);
  assert.doesNotMatch(rendered, /123456/);
});

test("Escape resolves cancellation exactly once", () => {
  const results: TelegramSetupResult[] = [];
  const widget = makeWidget(controller(), (result) => results.push(result));
  widget.handleInput("\x1b");
  widget.handleInput("\x1b");
  assert.deepEqual(results, [{ status: "cancelled" }]);
});

test("discovery feed renders candidates and explicit Done transitions to review", async () => {
  const c = controller();
  const widget = makeWidget(c);
  // Enter token, then observe a discovered chat.
  widget.handleInput("t");
  widget.handleInput("o");
  widget.handleInput("k");
  widget.handleInput("e");
  widget.handleInput("n");
  widget.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  widget.observeDiscovered("42");
  assert.match(plain(widget), /42/);
  // Down to the Done row and Enter.
  widget.handleInput("\x1b[B");
  widget.handleInput("\r");
  assert.match(plain(widget), /Choose allowed chats/);
  widget.dispose();
});

test("review toggles allow-list rows and exposes the default-chat selection hook", async () => {
  const c = controller();
  const widget = makeWidget(c);
  widget.handleInput("t");
  widget.handleInput("o");
  widget.handleInput("k");
  widget.handleInput("e");
  widget.handleInput("n");
  widget.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  widget.observeDiscovered("42");
  widget.handleInput("\x1b[B");
  widget.handleInput("\r");
  // First review row is selected. Toggle it and choose it as default.
  widget.handleInput("\r");
  widget.selectDefault("42");
  assert.equal(c.getState().allowedChatIds.includes("42"), true);
  assert.equal(c.getState().defaultChatId, "42");
  widget.dispose();
});

test("abort signal resolves cancellation", () => {
  const controllerAbort = new AbortController();
  const results: TelegramSetupResult[] = [];
  const widget = new TelegramChannelSetup({
    tui: fakeTui(),
    controller: controller(),
    theme: textTheme,
    done: (result) => results.push(result),
    signal: controllerAbort.signal,
  });
  controllerAbort.abort();
  assert.deepEqual(results, [{ status: "cancelled" }]);
  widget.invalidate();
});
