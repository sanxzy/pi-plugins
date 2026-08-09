import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConnectionMarker } from "@xzy-ai/channels";
import { registerSetupChannelCommand } from "../src/registrations/setup-channel.ts";

interface Command {
  name: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-setup-cmd-"));
}

function registrations(): { pi: ExtensionAPI; commands: Map<string, Command> } {
  const commands = new Map<string, Command>();
  return {
    commands,
    pi: {
      registerCommand(name: string, options: Omit<Command, "name">) {
        commands.set(name, { name, handler: options.handler });
      },
    } as unknown as ExtensionAPI,
  };
}

test("setup-channel-telegram command is registered", () => {
  const d = registrations();
  registerSetupChannelCommand(d.pi);
  assert.equal(d.commands.has("setup-channel-telegram"), true);
});

test("non-TUI mode reports an error and does not mount a widget", async () => {
  const root = projectRoot();
  try {
    const d = registrations();
    registerSetupChannelCommand(d.pi);
    let mounted = false;
    const ctx = {
      mode: "rpc",
      cwd: root,
      ui: {
        custom: async () => {
          mounted = true;
          return null;
        },
        notify: () => {},
      },
    } as unknown as ExtensionCommandContext;
    await d.commands.get("setup-channel-telegram")!.handler("", ctx);
    assert.equal(mounted, false);
    assert.equal(loadConnectionMarker(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});