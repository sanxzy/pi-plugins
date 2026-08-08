import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import piCodeExtension from "../index.ts";

interface ShortcutRegistration {
  shortcut: string;
  handler: (ctx: ExtensionContext) => Promise<void> | void;
}

type SessionStartHandler = (
  event: SessionStartEvent,
  ctx: ExtensionContext,
) => Promise<void> | void;

function makePi(shortcuts: ShortcutRegistration[], sessionStarts: SessionStartHandler[] = []): ExtensionAPI {
  return {
    registerTool() {},
    registerShortcut(shortcut: string, options: { handler: (ctx: ExtensionContext) => Promise<void> | void }) {
      shortcuts.push({ shortcut, handler: options.handler });
    },
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

function makeContext(cwd: string, mode: ExtensionContext["mode"], custom: ExtensionContext["ui"]["custom"], draft = "draft") {
  return {
    mode,
    hasUI: mode === "tui",
    cwd,
    ui: {
      custom,
      setWidget: () => {},
      setFooter: () => {},
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

test("registers the fixed Ctrl+Shift+A shortcut for TUI sessions", () => {
  const shortcuts: ShortcutRegistration[] = [];
  const sessionStarts: SessionStartHandler[] = [];
  piCodeExtension(makePi(shortcuts, sessionStarts));
  assert.ok(sessionStarts.length > 0, "extension listens for session_start");

  // Non-TUI start: the shortcut is not registered.
  const nonTuiCtx = makeContext("/tmp", "print", (() => Promise.resolve(undefined)) as unknown as ExtensionContext["ui"]["custom"]) as ExtensionContext;
  for (const handler of sessionStarts) handler({ type: "session_start", reason: "startup" }, nonTuiCtx);
  assert.equal(shortcuts.length, 0, "non-TUI sessions never register the manager shortcut");

  // TUI start: the fixed chord is registered with a centered overlay.
  const tuiCtx = makeContext("/tmp", "tui", (() => Promise.resolve(undefined)) as unknown as ExtensionContext["ui"]["custom"]) as ExtensionContext;
  for (const handler of sessionStarts) handler({ type: "session_start", reason: "startup" }, tuiCtx);
  const managerShortcut = shortcuts.find((entry) => entry.shortcut === "ctrl+shift+a");
  assert.ok(managerShortcut, "manager shortcut is registered for TUI sessions");
});

test("manager shortcut is TUI-only and repeated opens are guarded", async () => {
  const shortcuts: ShortcutRegistration[] = [];
  const sessionStarts: SessionStartHandler[] = [];
  piCodeExtension(makePi(shortcuts, sessionStarts));
  for (const handler of sessionStarts) {
    handler(
      { type: "session_start", reason: "startup" },
      makeContext(
        "/tmp",
        "tui",
        (() => Promise.resolve(undefined)) as unknown as ExtensionContext["ui"]["custom"],
      ),
    );
  }
  const managerShortcut = shortcuts.find((entry) => entry.shortcut === "ctrl+shift+a");
  assert.ok(managerShortcut);

  const root = await mkdtemp(join(tmpdir(), "pi-code-manager-"));
  try {
    let customCalls = 0;
    let overlayOptions: { overlay?: boolean; overlayOptions?: { anchor?: string } } | undefined;
    let closeManager: (() => void) | undefined;
    const custom = ((factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => unknown, options?: typeof overlayOptions) => {
      customCalls++;
      overlayOptions = options;
      return new Promise((resolve) => {
        const component = factory(
          { terminal: { rows: 24 }, requestRender: () => {} },
          { fg: (_color: string, text: string) => text },
          {},
          resolve,
        ) as { handleInput(data: string): void };
        closeManager = () => component.handleInput("");
      });
    }) as unknown as ExtensionContext["ui"]["custom"];

    editorWrites.length = 0;
    await managerShortcut.handler(makeContext(root, "rpc", custom));
    assert.equal(customCalls, 0, "non-TUI mode does not open the manager");

    const context = makeContext(root, "tui", custom);
    const firstOpen = managerShortcut.handler(context);
    await new Promise((resolve) => setImmediate(resolve));
    await managerShortcut.handler(context);
    assert.equal(customCalls, 1, "a second shortcut does not mount another modal");
    assert.equal(overlayOptions?.overlay, true);
    assert.equal(overlayOptions?.overlayOptions?.anchor, "center");

    closeManager?.();
    await firstOpen;
    assert.deepEqual(editorWrites, ["draft"], "composer draft is restored after close");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
