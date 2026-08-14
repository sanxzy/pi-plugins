import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import piC2Extension from "../index.ts";

interface ShortcutRegistration {
  shortcut: string;
  handler: (ctx: ExtensionContext) => Promise<void> | void;
}

type SessionStartHandler = (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void> | void;

function makePi(shortcuts: ShortcutRegistration[], sessionStarts: SessionStartHandler[] = []): ExtensionAPI {
  return {
    registerTool() {},
    registerShortcut(shortcut: string, options: { handler: (ctx: ExtensionContext) => Promise<void> | void }) {
      shortcuts.push({ shortcut, handler: options.handler });
    },
    registerCommand() {},
    on(event: string, handler: SessionStartHandler) {
      if (event === "session_start") sessionStarts.push(handler);
    },
    setActiveTools() {},
    getAllTools() {
      return [];
    },
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
}

test("the composition root no longer registers the Agent Manager shortcut", () => {
  const shortcuts: ShortcutRegistration[] = [];
  const sessionStarts: SessionStartHandler[] = [];
  piC2Extension(makePi(shortcuts, sessionStarts));

  assert.ok(sessionStarts.length > 0, "remaining lifecycle registrations stay active");
  const context = {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp",
    ui: { setFooter: () => {}, onTerminalInput: () => () => {} },
    sessionManager: {
      getSessionId: () => "root-session",
      getSessionFile: () => "/tmp/root-session.jsonl",
      getEntries: () => [],
      getCwd: () => "/tmp",
      getSessionName: () => undefined,
    },
  } as unknown as ExtensionContext;
  for (const handler of sessionStarts) handler({ type: "session_start", reason: "startup" }, context);
  assert.equal(
    shortcuts.some((entry) => entry.shortcut === "ctrl+shift+a"),
    false,
    "the removed manager shortcut is never registered",
  );
});
