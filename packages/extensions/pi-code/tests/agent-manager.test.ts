import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piCodeExtension from "../index.ts";

interface ShortcutRegistration {
  shortcut: string;
  handler: (ctx: ExtensionContext) => Promise<void> | void;
}

function makePi(shortcuts: ShortcutRegistration[]): ExtensionAPI {
  return {
    registerTool() {},
    registerShortcut(shortcut, options) {
      shortcuts.push({ shortcut, handler: options.handler });
    },
    on() {},
    setActiveTools() {},
    getAllTools() {
      return [];
    },
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
}

function makeContext(cwd: string, mode: ExtensionContext["mode"], custom: ExtensionContext["ui"]["custom"], draft = "draft") {
  return {
    mode,
    hasUI: mode === "tui",
    cwd,
    ui: {
      custom,
      getEditorText: () => draft,
      setEditorText: (text: string) => editorWrites.push(text),
      notify: () => {},
    },
    sessionManager: {
      getSessionId: () => "root-session",
      getSessionFile: () => join(cwd, "root.jsonl"),
    },
  } as unknown as ExtensionContext;
}

const editorWrites: string[] = [];

test("registers the fixed Ctrl+Shift+A shortcut with a centered overlay", () => {
  const shortcuts: ShortcutRegistration[] = [];
  piCodeExtension(makePi(shortcuts));
  const managerShortcut = shortcuts.find((entry) => entry.shortcut === "ctrl+shift+a");
  assert.ok(managerShortcut, "manager shortcut is registered");
});

test("manager shortcut is TUI-only and repeated opens are guarded", async () => {
  const shortcuts: ShortcutRegistration[] = [];
  piCodeExtension(makePi(shortcuts));
  const managerShortcut = shortcuts.find((entry) => entry.shortcut === "ctrl+shift+a");
  assert.ok(managerShortcut);

  const root = await mkdtemp(join(tmpdir(), "pi-code-manager-"));
  try {
    let customCalls = 0;
    let overlayOptions: { overlay?: boolean; overlayOptions?: { anchor?: string } } | undefined;
    let finish: ((value: unknown) => void) | undefined;
    const custom = ((factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => unknown, options?: typeof overlayOptions) => {
      customCalls++;
      overlayOptions = options;
      finish = (value) => factory({ terminal: { rows: 24 }, requestRender: () => {} }, { fg: (_color: string, text: string) => text }, {}, value);
      return new Promise(() => {});
    }) as unknown as ExtensionContext["ui"]["custom"];

    editorWrites.length = 0;
    await managerShortcut.handler(makeContext(root, "rpc", custom));
    assert.equal(customCalls, 0, "non-TUI mode does not open the manager");

    const context = makeContext(root, "tui", custom);
    await managerShortcut.handler(context);
    await managerShortcut.handler(context);
    assert.equal(customCalls, 1, "a second shortcut does not mount another modal");
    assert.equal(overlayOptions?.overlay, true);
    assert.equal(overlayOptions?.overlayOptions?.anchor, "center");

    finish?.({});
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(editorWrites, ["draft"], "composer draft is restored after close");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
