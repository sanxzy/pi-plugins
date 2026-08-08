import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerAgentFooter } from "../src/registrations/footer.ts";

/** ExtensionContext double exposing the UI surfaces the footer registration uses. */
function ctx(cwd: string, sessionId = "root-session"): ExtensionContext {
  return {
    mode: "tui",
    hasUI: true,
    cwd,
    ui: {
      setFooter: recordedSetFooter,
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

    // A background child settling emits session_shutdown(quit) from the child's
    // session id; the root-owned footer must ignore it.
    d.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx(cwd, "job-a"));
    assert.equal(restoredToNative, false, "a child shutdown does not restore the native footer");

    // Root session_shutdown restores the native footer.
    d.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "reload" }, ctx(cwd));
    assert.equal(restoredToNative, true, "root shutdown restores the native footer");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
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