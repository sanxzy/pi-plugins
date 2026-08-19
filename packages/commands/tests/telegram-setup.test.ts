import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerTelegramSetup } from "../src/registrations/telegram-setup.ts";

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

function api(): { pi: ExtensionAPI; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    pi: {
      registerCommand(name: string, options: { handler: Handler }) {
        handlers.set(name, options.handler);
      },
    } as unknown as ExtensionAPI,
  };
}

function commandContext(overrides: Partial<ExtensionCommandContext> = {}): ExtensionCommandContext {
  return {
    cwd: "/tmp/project",
    mode: "tui",
    hasUI: true,
    signal: undefined,
    ui: {
      custom: async () => ({ status: "cancelled" as const }),
      notify: () => {},
    },
    ...overrides,
  } as unknown as ExtensionCommandContext;
}

test("registers /c2-setup-channel-telegram", () => {
  const { pi, handlers } = api();
  registerTelegramSetup(pi);
  assert.equal(handlers.has("c2-setup-channel-telegram"), true);
});

test("refuses safely outside an interactive TUI context", async () => {
  const { pi, handlers } = api();
  const notified: string[] = [];
  registerTelegramSetup(pi);
  const ctx = commandContext({
    mode: "rpc",
    hasUI: true,
    ui: { notify: (m: string) => notified.push(m) } as unknown as ExtensionCommandContext["ui"],
  });
  await handlers.get("c2-setup-channel-telegram")!("/tmp/project", ctx);
  assert.equal(notified.length, 1, "a safe notification is emitted outside TUI");
  assert.match(notified[0]!, /requires an interactive TUI/);
});

test("opens the component through the host custom UI surface in TUI mode", async () => {
  const { pi, handlers } = api();
  const opened: string[] = [];
  registerTelegramSetup(pi);
  const ctx = commandContext({
    ui: {
      custom: async () => {
        opened.push("custom");
        return { status: "saved", message: "Telegram connection ready." };
      },
      notify: () => {},
    } as unknown as ExtensionCommandContext["ui"],
  });
  await handlers.get("c2-setup-channel-telegram")!("/tmp/project", ctx);
  assert.deepEqual(opened, ["custom"], "the setup component is mounted via ui.custom()");
});