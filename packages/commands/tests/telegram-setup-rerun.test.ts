import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readChannelConfig, createChannelManager, type ChannelPoller } from "@xzy-ai/channels";
import { registerTelegramSetup } from "../src/registrations/telegram-setup.ts";

const FIRST_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWX";
const SECOND_TOKEN = "987654321:ZYXWVUTSRQPONMLKJIHGFEDC";

function root(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-telegram-rerun-"));
}

function makeContext(cwd: string, custom: (factory: any) => Promise<unknown>): ExtensionCommandContext {
  return {
    cwd,
    mode: "tui",
    hasUI: true,
    signal: undefined,
    sessionManager: { getSessionId: () => "setup-session" },
    ui: { custom, notify: () => {} },
  } as unknown as ExtensionCommandContext;
}

function interactiveCustom(token: string) {
  return async (factory: any): Promise<unknown> => new Promise((resolve) => {
    const component = factory(
      { terminal: { rows: 24 }, requestRender: () => {} },
      { fg: (_color: string, text: string) => text },
      {},
      resolve,
    ) as { handleInput(data: string): void };
    for (const character of token) component.handleInput(character);
    component.handleInput("\r");
  });
}

test("rerunning setup reuses the project manager and stops before starting the replacement", async () => {
  const cwd = root();
  const events: string[] = [];
  const created = createChannelManager({
    projectRoot: cwd,
    createPoller: () => {
      const poller: ChannelPoller = {
        async start() {
          events.push("start");
          return { ok: true, value: undefined };
        },
        async stop() {
          events.push("stop");
        },
      };
      return poller;
    },
  });
  // The registration's manager factory is injected so this test can observe
  // replacement ordering without a real Telegram transport.
  const handlers = new Map<string, any>();
  const pi = {
    registerCommand(name: string, options: { handler: any }) {
      handlers.set(name, options.handler);
    },
  } as unknown as ExtensionAPI;
  registerTelegramSetup(pi, { createManager: () => created });
  const command = handlers.get("setup-channel-telegram")!;

  await command("", makeContext(cwd, interactiveCustom(FIRST_TOKEN)));
  await command("", makeContext(cwd, interactiveCustom(SECOND_TOKEN)));

  assert.deepEqual(events, ["start", "stop", "start"], "replacement stops before candidate startup");
  const config = readChannelConfig(cwd);
  assert.equal(config.ok, true);
  if (config.ok) assert.equal(config.value.token, SECOND_TOKEN);
  await created.stop();
});