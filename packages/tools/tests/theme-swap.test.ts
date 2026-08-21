// @ts-nocheck
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Theme } from "@earendil-works/pi-coding-agent";
import { createJob } from "@xzy-ai/core";
import { BUILTIN_THEME_PROFILES, clearThemeLibraryCache, getChildPool, homeThemesFile, loadThemeLibrary } from "@xzy-ai/runtime";
import { createNativeTheme, createThemeFrame } from "../src/theme-bridge.ts";
import { registerAgentFooter } from "../src/registrations/footer.ts";

const ALT_DOWN = "\x1bn";
const ENTER = "\r";
const ALT_LEFT = "\x1bb";

function context(cwd, currentTheme, calls) {
  let footerFactory;
  let inputHandler;
  const ui = {
    setFooter(factory) { footerFactory = factory; },
    onTerminalInput(handler) { inputHandler = handler; return () => { inputHandler = undefined; }; },
    confirm: async () => true,
    setTheme(next) {
      currentTheme.value = next;
      calls.push({ type: "theme", theme: next });
      return { success: true };
    },
    getTheme: () => currentTheme.value,
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd,
    ui,
    getContextUsage: () => undefined,
    model: undefined,
    sessionManager: {
      getSessionId: () => "root-session",
      getSessionFile: () => join(cwd, "root-session.jsonl"),
      getLeafId: () => undefined,
      getSessionName: () => undefined,
      getCwd: () => cwd,
      getEntries: () => [],
    },
  };
  return { ctx, ui, getFooterFactory: () => footerFactory, sendInput: (data) => inputHandler?.(data) };
}

function hostMode(currentTheme, calls, options = {}) {
  let depth = 0;
  return {
    hostSwapToSnapshot(session) {
      calls.push({ type: "snapshot", theme: currentTheme.value, snapshot: session?.snapshot });
      depth += 1;
    },
    hostSwapUpdateSnapshot() {
      calls.push({ type: "update", theme: currentTheme.value });
    },
    hostSwapRestore() {
      calls.push({ type: "restore", theme: currentTheme.value });
      depth -= 1;
      if (options.recordParentRebuild) calls.push({ type: "parent-rebuild", theme: currentTheme.value });
    },
    hostSwapDepth: () => depth,
  };
}

function register(pi, ctx) {
  registerAgentFooter(pi);
  pi.handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
}

function piDouble() {
  const handlers = new Map();
  return { handlers, on(event, handler) { handlers.set(event, handler); } };
}

test("profile conversion creates a native Theme with resolved variables", () => {
  const theme = createNativeTheme(BUILTIN_THEME_PROFILES[1]);
  assert.equal(theme instanceof Theme, true);
  assert.equal(theme.getColorMode(), "truecolor");
  assert.notEqual(theme.fg("text", "hello"), "hello");
  assert.notEqual(theme.bg("selectedBg", "hello"), "hello");
});

test("theme frames capture the parent, refresh updated profiles, and restore without persistence", () => {
  const parent = createNativeTheme(BUILTIN_THEME_PROFILES[0]);
  const current = { value: parent };
  const calls = [];
  const ui = {
    _hostGetThemeInstance: () => current.value,
    setTheme(next) { current.value = next; calls.push(next); return { success: true }; },
  };
  const frame = createThemeFrame(ui, BUILTIN_THEME_PROFILES[1]);
  assert.ok(frame);
  assert.notEqual(current.value, parent);
  assert.equal(frame.refresh(BUILTIN_THEME_PROFILES[0]), true);
  assert.equal(frame.refresh(BUILTIN_THEME_PROFILES[0]), false);
  frame.restore();
  assert.equal(current.value, parent);
  assert.equal(calls.length, 3);
});

test("native child rendering applies the profile before snapshot and restores before parent rebuild", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-theme-swap-"));
  try {
    const parent = createNativeTheme(BUILTIN_THEME_PROFILES[0]);
    const current = { value: parent };
    const calls = [];
    const d = piDouble();
    const { ctx, getFooterFactory, sendInput } = context(cwd, current, calls);
    register(d, ctx);
    const pool = getChildPool(cwd, "root-session");
    const feed = {
      snapshot: { status: "running", settled: false, transcript: [{ id: "m", kind: "message", role: "assistant", text: "child", complete: true }, { id: "tool", kind: "tool", toolCallId: "call-1", toolName: "read", args: { path: "src/index.ts" }, text: "result", complete: true, isError: false }], counters: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 } },
      subscribe: () => () => {},
      steer: async () => {},
    };
    pool.liveChildren.set("theme-child", { sessionFile: join(cwd, "child.jsonl"), live: feed, steer: async () => {}, abort: async () => {} });
    pool.registry.createJob(createJob({ jobId: "theme-child", parentSessionId: "root-session", sessionId: "theme-child", status: "running", description: "theme child", subagentType: "test-agent", themeId: "light" }));
    const mode = hostMode(current, calls, { recordParentRebuild: true });
    const tui = { terminal: { rows: 24, columns: 100 }, requestRender() {}, _hostInteractiveMode: mode, _hostGetThemeInstance: () => current.value };
    const footer = getFooterFactory()(tui, { fg: (_c, text) => text }, { onBranchChange: () => () => {}, getGitBranch: () => "main", getAvailableProviderCount: () => 1 });
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ENTER);
    assert.equal(calls[0]?.type, "theme");
    assert.equal(calls[1]?.type, "snapshot");
    assert.equal(calls[1]?.theme.name, "Light");
    assert.equal(calls[1]?.snapshot.transcript[1]?.toolName, "read");
    assert.deepEqual(calls[1]?.snapshot.transcript[1]?.args, { path: "src/index.ts" });
    sendInput(ALT_LEFT);
    assert.equal(calls.at(-2)?.type, "restore");
    assert.equal(calls.at(-2)?.theme, parent);
    assert.equal(calls.at(-1)?.type, "parent-rebuild");
    assert.equal(calls.at(-1)?.theme, parent);
    assert.equal(current.value, parent);
    footer.dispose();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("active child refresh applies valid profile updates through the native host", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-theme-refresh-"));
  const original = loadThemeLibrary();
  try {
    const parent = createNativeTheme(BUILTIN_THEME_PROFILES[0]);
    const current = { value: parent };
    const calls = [];
    const d = piDouble();
    const { ctx, getFooterFactory } = context(cwd, current, calls);
    register(d, ctx);
    const pool = getChildPool(cwd, "root-session");
    const feed = { snapshot: { status: "running", settled: false, transcript: [], counters: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 } }, subscribe: () => () => {}, steer: async () => {} };
    pool.liveChildren.set("refresh-child", { sessionFile: join(cwd, "child.jsonl"), live: feed, steer: async () => {}, abort: async () => {} });
    pool.registry.createJob(createJob({ jobId: "refresh-child", parentSessionId: "root-session", sessionId: "refresh-child", status: "running", description: "refresh", subagentType: "test-agent", themeId: "light" }));
    const mode = hostMode(current, calls);
    const tui = { terminal: { rows: 24, columns: 100 }, requestRender() {}, _hostInteractiveMode: mode, _hostGetThemeInstance: () => current.value };
    const footer = getFooterFactory()(tui, { fg: (_c, text) => text }, { onBranchChange: () => () => {}, getGitBranch: () => "main", getAvailableProviderCount: () => 1 });
    footer.handleInput(ALT_DOWN); footer.handleInput(ALT_DOWN); footer.handleInput(ENTER);
    const library = JSON.parse(JSON.stringify(original));
    const light = library.profiles.find((profile) => profile.themeId === "light");
    light.colors.accent = "#123456";
    writeFileSync(homeThemesFile(), JSON.stringify(library));
    clearThemeLibraryCache();
    footer.render(100);
    assert.equal(calls.some((entry) => entry.type === "update"), true);
    assert.equal(calls.at(-1)?.type, "update");
    assert.equal(calls.at(-1)?.theme.name, "Light");
    footer.dispose();
  } finally {
    writeFileSync(homeThemesFile(), JSON.stringify(original));
    clearThemeLibraryCache();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("legacy child views do not mutate the parent theme", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-theme-legacy-"));
  try {
    const parent = createNativeTheme(BUILTIN_THEME_PROFILES[0]);
    const current = { value: parent };
    const calls = [];
    const d = piDouble();
    const { ctx, getFooterFactory, sendInput } = context(cwd, current, calls);
    register(d, ctx);
    const pool = getChildPool(cwd, "root-session");
    pool.liveChildren.set("legacy-child", { sessionFile: join(cwd, "child.jsonl"), live: { snapshot: { status: "running", settled: false, transcript: [], counters: {} }, subscribe: () => () => {} }, steer: async () => {}, abort: async () => {} });
    pool.registry.createJob(createJob({ jobId: "legacy-child", parentSessionId: "root-session", sessionId: "legacy-child", status: "running", description: "legacy", subagentType: "test-agent" }));
    const mode = hostMode(current, calls);
    const tui = { terminal: { rows: 24, columns: 100 }, requestRender() {}, _hostInteractiveMode: mode, _hostGetThemeInstance: () => current.value };
    const footer = getFooterFactory()(tui, { fg: (_c, text) => text }, { onBranchChange: () => () => {}, getGitBranch: () => "main", getAvailableProviderCount: () => 1 });
    footer.handleInput(ALT_DOWN); footer.handleInput(ALT_DOWN); footer.handleInput(ENTER);
    sendInput(ALT_LEFT);
    assert.equal(calls.some((entry) => entry.type === "theme"), false);
    assert.equal(current.value, parent);
    footer.dispose();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
