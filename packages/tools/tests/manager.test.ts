import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createJob, type ChildSessionControl } from "@xzy-ai/core";
import { getChildPool } from "@xzy-ai/runtime";
import { registerManagerShortcut } from "../src/registrations/manager.ts";

/**
 * Host-lifecycle tests for the agent manager registration.
 *
 * Closing the manager disposes synchronously through the mounted component,
 * but a host UI reset (`resetExtensionUI` on /reload or session replacement)
 * pops the overlay without calling the component's `dispose()`. The manager
 * registration therefore runs its own teardown on `session_shutdown` reasons
 * that replace the UI, disposing modal subscriptions without aborting or
 * re-hosting any child and without invoking the shutdown interruption sweep.
 */

/** The host `setWidget` calls the ticker registration issues, keyed by widget key. */
const widgetFactories = new Map<string, ((tui: unknown, theme: unknown) => unknown) | string[]>();

/** ExtensionContext double exposing the surfaces the manager uses. */
function ctx(cwd: string, sessionId = "root-session"): ExtensionContext {
  return {
    mode: "tui",
    hasUI: true,
    cwd,
    ui: {
      custom: capturedCustom,
      setWidget: (key: string, content: ((tui: unknown, theme: unknown) => unknown) | undefined) => {
        if (content === undefined) widgetFactories.delete(key);
        else widgetFactories.set(key, content);
      },
      getEditorText: () => "draft",
      setEditorText: (_text: string) => {},
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => join(cwd, "sessions", `${sessionId}.jsonl`),
    } as unknown as ExtensionContext["sessionManager"],
  } as unknown as ExtensionContext;
}

/** The host `custom` stub: capture the factory so a test can mount it. */
let capturedFactory:
  | ((tui: unknown, theme: unknown, keybindings: unknown, done: (reason: string) => void) => unknown)
  | undefined;
async function capturedCustom(factory: unknown, _options?: unknown): Promise<unknown> {
  capturedFactory = factory as typeof capturedFactory;
  return undefined;
}

/** ExtensionAPI double recording event handlers and the manager shortcut. */
function piDouble(): {
  pi: ExtensionAPI;
  handlers: Map<string, (event: unknown, ctx: ExtensionContext) => void>;
  shortcut: ((ctx: ExtensionContext) => void) | undefined;
} {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  let shortcut: ((ctx: ExtensionContext) => void) | undefined;
  return {
    handlers,
    get shortcut() {
      return shortcut;
    },
    pi: {
      on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
        handlers.set(event, handler);
      },
      registerShortcut(_shortcut: string, options: { handler: (ctx: ExtensionContext) => void }) {
        shortcut = options.handler;
      },
    } as unknown as ExtensionAPI,
  };
}

test("the manager shortcut is registered for TUI sessions only", () => {
  const d = piDouble();
  registerManagerShortcut(d.pi);
  assert.equal(d.handlers.has("session_start"), true);
  assert.equal(d.handlers.has("session_shutdown"), true);
  startManager(d, mkdtempSync(join(tmpdir(), "pi-code-manager-")));
  assert.equal(typeof d.shortcut, "function", "Ctrl+Shift+A opens the manager");
});

function startManager(d: ReturnType<typeof piDouble>, cwd: string): void {
  d.handlers.get("session_start")!(
    { type: "session_start", reason: "startup" },
    ctx(cwd),
  );
}

test("host reset on session_shutdown disposes the mounted manager without aborting the child", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-manager-"));
  const pool = getChildPool(cwd);
  // Publish a running child handle whose abort is spied; the interruption sweep
  // (owned by the pool) is the only path that should ever abort it.
  let abortCalls = 0;
  const liveControl: ChildSessionControl = {
    sessionFile: join(cwd, "sessions", "job-a.jsonl"),
    steer: async () => {},
    abort: async () => {
      abortCalls++;
    },
    live: {
      snapshot: { status: "running" as const, settled: false, transcript: [] },
      subscribe: () => () => {},
      steer: async () => {},
      abort: async () => {
        abortCalls++;
      },
    },
  };
  pool.liveChildren.set("job-a", liveControl);
  // job-a owns a scoped registry job, so it is a CHILD session: its own
  // shutdown must not close the root manager.
  pool.registry.createJob(createJob({ jobId: "job-a", parentSessionId: "root-session", status: "running", description: "job-a", subagentType: "default" }));

  const d = piDouble();
  registerManagerShortcut(d.pi);
  // session_start binds the shortcut; pressing it mounts the manager overlay.
  startManager(d, cwd);
  d.shortcut!(ctx(cwd));
  assert.ok(capturedFactory, "the manager overlay factory was requested");
  const mounted = capturedFactory!({ requestRender: () => {} }, {}, {}, () => {
    /* done */
  });
  assert.ok(mounted, "the manager component mounted");

  // Spy on the mounted manager's dispose so we can observe host teardown.
  const component = mounted as { dispose?: () => void };
  const realDispose = component.dispose?.bind(component) ?? (() => {});
  let disposed = 0;
  component.dispose = () => {
    disposed++;
    realDispose();
  };

  // Closed-copy: the component returns nothing observable; host reset survival
  // is the behavior under test.

  // A background child settling emits its own session_shutdown(quit) from the
  // child's session id; the root-owned manager must ignore it so the settled
  // view stays open.
  d.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx(cwd, "job-a"));
  assert.equal(disposed, 0, "a child shutdown does not close the manager");

  // A host reset on session replacement fires session_shutdown(reload) BEFORE
  // resetExtensionUI pops the overlay. The registration must dispose the
  // manager so modal subscriptions release, while never aborting the child.
  d.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "reload" }, ctx(cwd));
  assert.equal(disposed, 1, "session_shutdown(reload) disposes the mounted manager");
  assert.equal(abortCalls, 0, "host reset never aborts a running child");

  // Navigation and teardown never invoke the interruption sweep: the child
  // stays running in the pool after a live manager is torn down.
  assert.equal(pool.liveChildren.has("job-a"), true);

  rmSync(cwd, { recursive: true, force: true });
});

test("the agent activity ticker mounts above the composer for TUI sessions only", () => {
  const d = piDouble();
  registerManagerShortcut(d.pi);
  startManager(d, mkdtempSync(join(tmpdir(), "pi-code-ticker-")));

  // The ticker registration is part of the manager registration; a TUI start
  // wires the widget above the editor.
  assert.ok(widgetFactories.has("pi-code-agent-ticker"), "the ticker widget is registered for TUI sessions");
  const factory = widgetFactories.get("pi-code-agent-ticker");
  assert.ok(typeof factory === "function", "the ticker is mounted as a component, not plain lines");
});

test("the ticker widget reflects a running child's latest activity", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-ticker-"));
  const pool = getChildPool(cwd);
  pool.liveChildren.set("job-a", {
    live: {
      snapshot: {
        status: "running",
        settled: false,
        transcript: [
          { id: "t1", kind: "tool", toolCallId: "call-1", toolName: "bash", text: "", complete: false },
        ],
      },
      subscribe: () => () => {},
      steer: async () => {},
      abort: async () => {},
    },
  });

  const d = piDouble();
  registerManagerShortcut(d.pi);
  startManager(d, cwd);
  const factory = widgetFactories.get("pi-code-agent-ticker");
  assert.ok(typeof factory === "function", "the ticker is registered");
  const mounted = factory!({ terminal: { rows: 24, columns: 100 }, requestRender: () => {} }, {
    fg: (_color: string, text: string) => text,
  }) as unknown as { render(width: number): string[] };
  const lines = mounted.render(80).map((line) => line);
  assert.match(lines.join("\n"), /bash/, "the running child's tool activity feeds the ticker");
  (mounted as unknown as { dispose?: () => void }).dispose?.();

  rmSync(cwd, { recursive: true, force: true });
});
