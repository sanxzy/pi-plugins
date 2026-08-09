import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { loadConnectionMarker, saveConnectionMarker } from "@xzy-ai/channels";
import { registerConnectionMarker, markTui, type ConnectionMarkerDeps } from "../src/registrations/connection-marker.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-conn-marker-"));
}

function registrations(deps: ConnectionMarkerDeps = {}): { pi: ExtensionAPI; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    pi: {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI,
  };
}

function context(cwd: string): ExtensionContext {
  return { cwd } as unknown as ExtensionContext;
}

function inputEvent(source: InputEvent["source"]): InputEvent {
  return { type: "input", text: "hello", source };
}

test("an interactive prompt sets the marker to tui", () => {
  const root = projectRoot();
  try {
    const d = registrations();
    registerConnectionMarker(d.pi);
    d.handlers.get("input")!(inputEvent("interactive"), context(root));
    assert.equal(loadConnectionMarker(root)?.lastConnection, "tui");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-interactive input does not change the marker", () => {
  const root = projectRoot();
  try {
    saveConnectionMarker(root, { lastConnection: "telegram", updatedAt: "2026-01-01T00:00:00.000Z" });
    const d = registrations();
    registerConnectionMarker(d.pi);
    d.handlers.get("input")!(inputEvent("rpc"), context(root));
    assert.equal(loadConnectionMarker(root)?.lastConnection, "telegram");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("markTui writes the tui marker atomically and fresh", () => {
  const root = projectRoot();
  try {
    saveConnectionMarker(root, { lastConnection: "telegram", updatedAt: "2026-01-01T00:00:00.000Z" });
    markTui(root);
    const loaded = loadConnectionMarker(root);
    assert.equal(loaded?.lastConnection, "tui");
    assert.equal(typeof loaded?.updatedAt, "string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing or malformed marker resolves to tui and prevents telegram delivery", () => {
  const root = projectRoot();
  try {
    // Missing marker: loadConnectionMarker returns null (not telegram-safe).
    assert.equal(loadConnectionMarker(root), null);
    // A malformed marker also resolves to null.
    saveConnectionMarker(root, { lastConnection: "telegram", updatedAt: "2026-01-01T00:00:00.000Z" });
    mkdirSync(join(root, ".pi", "pi-code"), { recursive: true });
    writeFileSync(join(root, ".pi", "pi-code", "user_last_connection.json"), "broken", "utf-8");
    assert.equal(loadConnectionMarker(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the input handler is registered alongside existing lifecycle handlers", () => {
  const d = registrations();
  registerConnectionMarker(d.pi);
  assert.equal(d.handlers.has("input"), true);
});