import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createChildLiveFeed, createJob } from "@xzy-ai/core";
import { getChildPool } from "@xzy-ai/runtime";
import { TOOL_OPERATIONS, createSessionLogger, runWithLogContext } from "@xzy-ai/observability";
import { registerAgentFooter, createFooterHeartbeat } from "../src/registrations/footer.ts";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ALT_DOWN = "\x1bn";
const ALT_UP = "\x1bp";
const ALT_LEFT = "\x1bb";
const ENTER = "\r";
const ESC = "\x1b";
const ALT_X = "\x1bx";

/** Pending confirmation promise surface wired into the ctx double. */
let confirmResult: Promise<boolean> = Promise.resolve(true);
function recordedConfirm(_title: string, _message: string): Promise<boolean> {
  return confirmResult;
}

/** ExtensionContext double exposing the UI surfaces the footer registration uses. */
function ctx(cwd: string, sessionId = "root-session"): ExtensionContext {
  return {
    mode: "tui",
    hasUI: true,
    cwd,
    ui: {
      setFooter: recordedSetFooter,
      onTerminalInput: recordedOnTerminalInput,
      custom: recordedCustom,
      confirm: recordedConfirm,
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => join(cwd, "sessions", `${sessionId}.jsonl`),
    } as unknown as ExtensionContext["sessionManager"],
  } as unknown as ExtensionContext;
}

/** The host `setFooter` stub: capture the factory so a test can mount it. */
let capturedFooterFactory:
  | ((tui: unknown, theme: unknown, footerData: unknown) => unknown)
  | undefined;
let restoredToNative = false;
let capturedCustomFactory:
  | ((tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => unknown)
  | undefined;
let capturedCustomOptions: unknown;
function recordedCustom(factory: unknown, options?: unknown): Promise<unknown> {
  capturedCustomFactory = factory as typeof capturedCustomFactory;
  capturedCustomOptions = options;
  return Promise.resolve(undefined);
}
let terminalInputHandler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
function recordedOnTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void {
  terminalInputHandler = handler;
  return () => {
    if (terminalInputHandler === handler) terminalInputHandler = undefined;
  };
}
function recordedSetFooter(factory: ((tui: unknown, theme: unknown, footerData: unknown) => unknown) | undefined) {
  if (factory === undefined) {
    restoredToNative = true;
    capturedFooterFactory = undefined;
    return;
  }
  restoredToNative = false;
  capturedFooterFactory = factory;
}

/** ExtensionAPI double recording event handlers. */
function piDouble(): {
  pi: ExtensionAPI;
  handlers: Map<string, (event: unknown, ctx: ExtensionContext) => void>;
} {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  return {
    handlers,
    pi: {
      on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI,
  };
}

test("the footer heartbeat repaints once per second only while a child is running", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    let repaints = 0;
    const live = { snapshot: { status: "running" } };
    const stop = createFooterHeartbeat(new Map([["job-a", { live }]]), () => {
      repaints++;
    });

    mock.timers.tick(999);
    assert.equal(repaints, 0, "the heartbeat waits one second before repainting");
    mock.timers.tick(1);
    assert.equal(repaints, 1, "a running child receives a heartbeat repaint");

    live.snapshot.status = "completed";
    mock.timers.tick(2_000);
    assert.equal(repaints, 1, "settled children do not receive heartbeat repaints");

    stop();
    live.snapshot.status = "running";
    mock.timers.tick(2_000);
    assert.equal(repaints, 1, "disposing the heartbeat stops future repaints");
  } finally {
    mock.timers.reset();
  }
});

test("the custom footer is installed for TUI sessions and restored on root shutdown", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-footer-"));
  try {
    const d = piDouble();
    registerAgentFooter(d.pi);
    assert.equal(d.handlers.has("session_start"), true);
    assert.equal(d.handlers.has("session_shutdown"), true);

    d.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx(cwd));
    assert.equal(typeof capturedFooterFactory, "function", "TUI session installs the custom footer");
    assert.equal(restoredToNative, false);

    // Publish a scoped child job so the pool recognizes the child session id;
    // the root-owned footer must ignore the child's own shutdown.
    const pool = getChildPool(cwd, "root-session");
    pool.registry.createJob(createJob({ jobId: "job-a", parentSessionId: "root-session", sessionId: "job-a", status: "running", description: "job-a", subagentType: "test-agent" }));
    d.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx(cwd, "job-a"));
    assert.equal(restoredToNative, false, "a child shutdown does not restore the native footer");

    // Root session_shutdown restores the native footer.
    d.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "reload" }, ctx(cwd));
    assert.equal(restoredToNative, true, "root shutdown restores the native footer");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("non-TUI footer lifecycle is a silent no-op (H9)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-footer-noop-"));
  const logDir = mkdtempSync(join(tmpdir(), "pi-code-footer-noop-log-"));
  try {
    const d = piDouble();
    registerAgentFooter(d.pi);
    const logger = createSessionLogger({ projectId: "project", rootSessionId: "root", eventsPath: join(logDir, "events.jsonl"), errorsPath: join(logDir, "errors.jsonl") });
    const nonTui: ExtensionContext = { ...ctx(cwd), mode: "print", hasUI: false } as ExtensionContext;
    runWithLogContext(logger, () => d.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, nonTui));
    assert.equal(existsSync(join(logDir, "events.jsonl")), false, "non-TUI no-op must not create telemetry files");
    // The shutdown guard is symmetric: a non-TUI session never had a footer, so
    // FOOTER_STOP must stay telemetry-silent and never touch the UI surface.
    d.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, nonTui);
    assert.equal(existsSync(join(logDir, "events.jsonl")), false, "non-TUI shutdown no-op must not create telemetry files");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("the custom footer is never installed for non-TUI sessions", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-footer-"));
  try {
    const d = piDouble();
    registerAgentFooter(d.pi);
    const nonTui: ExtensionContext = { ...ctx(cwd), mode: "print", hasUI: false } as ExtensionContext;
    d.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, nonTui);
    assert.equal(capturedFooterFactory, undefined, "non-TUI sessions never install the custom footer");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("footer management mode consumes navigation keys and passes others through", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-footer-"));
  try {
    const d = piDouble();
    registerAgentFooter(d.pi);
    d.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx(cwd));
    assert.ok(capturedFooterFactory, "footer factory installed");

    // The host mounts the footer component; input routing starts with the mount.
    const tui = { requestRender: () => {}, terminal: { rows: 24, columns: 100 } };
    const footer = capturedFooterFactory!(tui, { fg: (_c: string, t: string) => t }, {
      onBranchChange: () => () => {},
      getGitBranch: () => "main",
      getAvailableProviderCount: () => 1,
    }) as { dispose: () => void };
    assert.ok(terminalInputHandler, "terminal input handler registered on mount");

    // Ordinary input and arrows pass through; Alt+Down enters management mode.
    assert.equal(terminalInputHandler!("hello")?.consume, false);
    assert.equal(terminalInputHandler!("hello")?.data, "hello");
    assert.equal(terminalInputHandler!(UP)?.consume, false, "up passes through outside management");
    assert.equal(terminalInputHandler!(DOWN)?.consume, false, "down passes through outside management");

    // Alt+arrow navigation is consumed; Enter on main exits management.
    assert.equal(terminalInputHandler!(ALT_DOWN)?.consume, true);
    assert.equal(terminalInputHandler!(ALT_DOWN)?.consume, true);
    assert.equal(terminalInputHandler!(ALT_UP)?.consume, true);
    assert.equal(terminalInputHandler!(ALT_LEFT)?.consume, true);
    assert.equal(terminalInputHandler!(ENTER)?.consume, false, "Enter reaches composer after left exits management");

    // Re-enter and confirm Enter on the root exits management mode.
    terminalInputHandler!(ALT_DOWN);
    assert.equal(terminalInputHandler!(ENTER)?.consume, true);
    assert.equal(terminalInputHandler!("x")?.consume, false, "after exit, text passes through");

    footer.dispose();
    assert.equal(terminalInputHandler, undefined, "dispose releases the input listener");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Enter on a running child mounts the live view; cancel aborts, close does not", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-footer-"));
  try {
    const d = piDouble();
    registerAgentFooter(d.pi);
    d.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx(cwd));
    assert.ok(capturedFooterFactory);

    const pool = getChildPool(cwd, "root-session");
    const feed = createChildLiveFeed();
    let aborted = 0;
    pool.liveChildren.set("job-a", {
      sessionFile: join(cwd, "sessions", "job-a.jsonl"),
      live: feed,
      steer: async () => {},
      abort: async () => {
        aborted++;
      },
    });
    pool.registry.createJob(createJob({ jobId: "job-a", parentSessionId: "root-session", sessionId: "job-a", status: "running", description: "Implement", subagentType: "test-agent" }));

    const context = ctx(cwd);
    const tui = { requestRender: () => {}, terminal: { rows: 24, columns: 100 } };
    const footer = capturedFooterFactory!(tui, { fg: (_c: string, t: string) => t }, {
      onBranchChange: () => () => {},
      getGitBranch: () => "main",
      getAvailableProviderCount: () => 1,
    }) as { handleInput(data: string): boolean; dispose(): void };

    // Outside management, Alt+Down enters; Alt+Down to the child; Enter mounts the live view.
    assert.equal(footer.handleInput(ALT_DOWN), true);
    assert.equal(footer.handleInput(ALT_DOWN), true);
    assert.equal(footer.handleInput(ENTER), true);
    assert.ok(capturedCustomFactory, "Enter mounts the focused live view overlay");

    const mounted = capturedCustomFactory!({ requestRender: () => {}, terminal: { rows: 24 } }, { fg: (_c: string, t: string) => t }, {}, () => {}) as {
      handleInput(data: string): void;
      dispose(): void;
    };
    assert.ok(mounted, "live view component mounted");

    // Closing the view never aborts the child.
    mounted.handleInput(ESC);
    assert.equal(aborted, 0, "closing the live view never aborts the child");

    // Re-enter and cancel with Alt+x; the confirmation accepts and aborts.
    terminalInputHandler!(ALT_DOWN);
    terminalInputHandler!(ALT_DOWN);
    terminalInputHandler!(ENTER);
    const liveView = capturedCustomFactory!({ requestRender: () => {}, terminal: { rows: 24 } }, { fg: (_c: string, t: string) => t }, {}, () => {}) as {
      handleInput(data: string): void;
      dispose(): void;
    };
    assert.ok(confirmResult, "confirmation surface is wired");
    liveView.handleInput(ALT_X);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(aborted, 1, "confirmed cancellation aborts the child via the runtime path");

    footer.dispose();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("live transcript events repaint the mounted live view without steering", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-footer-"));
  try {
    const d = piDouble();
    registerAgentFooter(d.pi);
    d.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx(cwd));

    const pool = getChildPool(cwd, "root-session");
    const feed = createChildLiveFeed();
    pool.liveChildren.set("job-a", {
      sessionFile: join(cwd, "sessions", "job-a.jsonl"),
      live: feed,
      steer: async () => {},
      abort: async () => {},
    });
    pool.registry.createJob(createJob({ jobId: "job-a", parentSessionId: "root-session", sessionId: "job-a", status: "running", description: "Implement", subagentType: "test-agent" }));

    const tui = { requestRender: () => {}, terminal: { rows: 24, columns: 100 } };
    const footer = capturedFooterFactory!(tui, { fg: (_c: string, t: string) => t }, {
      onBranchChange: () => () => {},
      getGitBranch: () => "main",
      getAvailableProviderCount: () => 1,
    }) as { handleInput(data: string): boolean; dispose(): void };

    // Enter mounts the live view through the host custom surface.
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ENTER);
    assert.ok(capturedCustomFactory, "live view mounts through the host custom surface");

    let repaints = 0;
    let doneCalls = 0;
    const mounted = capturedCustomFactory!({ requestRender: () => { repaints++; }, terminal: { rows: 24 } }, { fg: (_c: string, t: string) => t }, {}, () => { doneCalls++; }) as {
      handleInput(data: string): void;
      dispose(): void;
    };
    assert.ok(mounted, "live view component mounts");

    // A live transcript event repaints the mounted view.
    feed.emit({ type: "message", id: "m1", phase: "start", role: "assistant", text: "thinking" });
    assert.ok(repaints > 0, "a live transcript event repaints the mounted view");

    // Closing the live view resolves the host `done`, which closes the overlay.
    mounted.handleInput(ESC);
    assert.equal(doneCalls, 1, "closing the live view resolves the host done callback");

    mounted.dispose();
    footer.dispose();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the live overlay mount does not delegate height truncation to the host", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-footer-"));
  try {
    const d = piDouble();
    registerAgentFooter(d.pi);
    d.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx(cwd));

    const pool = getChildPool(cwd, "root-session");
    const feed = createChildLiveFeed();
    pool.liveChildren.set("job-a", {
      sessionFile: join(cwd, "sessions", "job-a.jsonl"),
      live: feed,
      steer: async () => {},
      abort: async () => {},
    });
    pool.registry.createJob(createJob({ jobId: "job-a", parentSessionId: "root-session", sessionId: "job-a", status: "running", description: "Implement", subagentType: "test-agent" }));

    const tui = { requestRender: () => {}, terminal: { rows: 24, columns: 100 } };
    const footer = capturedFooterFactory!(tui, { fg: (_c: string, t: string) => t }, {
      onBranchChange: () => () => {},
      getGitBranch: () => "main",
      getAvailableProviderCount: () => 1,
    }) as { handleInput(data: string): boolean; dispose(): void };
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ENTER);

    const options = capturedCustomOptions as { overlayOptions?: { maxHeight?: unknown } } | undefined;
    assert.equal(options?.overlayOptions?.maxHeight, undefined, "the host must not slice the bottom of the panel");
    footer.dispose();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the footer factory is re-installed after a host UI reset", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-footer-"));
  try {
    const d = piDouble();
    registerAgentFooter(d.pi);

    // First TUI start installs the footer.
    d.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx(cwd));
    assert.equal(typeof capturedFooterFactory, "function");

    // A host reset tears the footer down and re-fires session_start; the
    // registration must re-install it.
    d.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "reload" }, ctx(cwd));
    assert.equal(restoredToNative, true);
    d.handlers.get("session_start")!({ type: "session_start", reason: "reload" }, ctx(cwd));
    assert.equal(typeof capturedFooterFactory, "function", "footer is re-installed after host UI reset");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});