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
      if (options.failSnapshotAfterPush) {
        depth += 1;
        throw new Error("host render failed after push");
      }
      calls.push({ type: "snapshot", theme: currentTheme.value, snapshot: session?.snapshot });
      depth += 1;
    },
    hostSwapUpdateSnapshot(session) {
      calls.push({ type: "update", theme: currentTheme.value, snapshot: session?.snapshot });
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

test("native themes adapt to the terminal color capability", () => {
  const profile = BUILTIN_THEME_PROFILES[2]!;
  const capped = createNativeTheme(profile, { trueColor: false });
  assert.equal(capped.getColorMode(), "256color");
  assert.ok(capped.bg("toolPendingBg", "x").includes("48;5;"));
  assert.ok(capped.fg("text", "x").includes("38;5;"));
  const trueColor = createNativeTheme(profile, { trueColor: true });
  assert.equal(trueColor.getColorMode(), "truecolor");
  assert.ok(trueColor.bg("toolPendingBg", "x").includes("48;2;"));
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
    pool.registry.createJob(createJob({ jobId: "theme-child", parentSessionId: "root-session", sessionId: "theme-child", status: "running", description: "theme child", subagentType: "test-agent", themeId: "dracula" }));
    const mode = hostMode(current, calls, { recordParentRebuild: true });
    const tui = { terminal: { rows: 24, columns: 100 }, requestRender() {}, _hostInteractiveMode: mode, _hostGetThemeInstance: () => current.value };
    const footer = getFooterFactory()(tui, { fg: (_c, text) => text }, { onBranchChange: () => () => {}, getGitBranch: () => "main", getAvailableProviderCount: () => 1 });
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ENTER);
    assert.equal(calls[0]?.type, "theme");
    assert.equal(calls[1]?.type, "snapshot");
    assert.equal(calls[1]?.theme.name, "Dracula");
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

test("nested themed children restore one frame at a time", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-theme-nested-"));
  try {
    const parent = createNativeTheme(BUILTIN_THEME_PROFILES[0]);
    const current = { value: parent };
    const calls = [];
    const d = piDouble();
    const { ctx, getFooterFactory, sendInput } = context(cwd, current, calls);
    register(d, ctx);
    const pool = getChildPool(cwd, "root-session");
    const addRunning = (jobId, sessionId, parentSessionId, themeId) => {
      const feed = { snapshot: { status: "running", settled: false, transcript: [], counters: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 } }, subscribe: () => () => {}, steer: async () => {} };
      pool.liveChildren.set(jobId, { sessionFile: join(cwd, `${jobId}.jsonl`), live: feed, steer: async () => {}, abort: async () => {} });
      pool.registry.createJob(createJob({ jobId, parentSessionId, sessionId, status: "running", description: jobId, subagentType: "test-agent", themeId }));
    };
    addRunning("first", "first-session", "root-session", "dracula");
    addRunning("second", "second-session", "first-session", "dark");
    const mode = hostMode(current, calls);
    const tui = { terminal: { rows: 24, columns: 100 }, requestRender() {}, _hostInteractiveMode: mode, _hostGetThemeInstance: () => current.value };
    const footer = getFooterFactory()(tui, { fg: (_c, text) => text }, { onBranchChange: () => () => {}, getGitBranch: () => "main", getAvailableProviderCount: () => 1 });
    footer.handleInput(ALT_DOWN); footer.handleInput(ALT_DOWN); footer.handleInput(ENTER);
    assert.equal(current.value.name, "Dracula");
    footer.handleInput(ALT_DOWN); footer.handleInput(ALT_DOWN); footer.handleInput(ENTER);
    assert.equal(mode.hostSwapDepth(), 2);
    assert.equal(current.value.name, "Deep Space");
    assert.notEqual(current.value, parent);
    sendInput(ALT_LEFT);
    assert.equal(mode.hostSwapDepth(), 1);
    assert.equal(current.value.name, "Dracula");
    sendInput(ALT_LEFT);
    assert.equal(mode.hostSwapDepth(), 0);
    assert.equal(current.value, parent);
    footer.dispose();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("failed lookup, settled viewing, and footer teardown leave theme and host stacks balanced", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-theme-lifecycle-"));
  try {
    const parent = createNativeTheme(BUILTIN_THEME_PROFILES[0]);
    const current = { value: parent };
    const calls = [];
    const d = piDouble();
    const { ctx, getFooterFactory } = context(cwd, current, calls);
    register(d, ctx);
    const pool = getChildPool(cwd, "root-session");
    pool.registry.createJob(createJob({ jobId: "missing-live", parentSessionId: "root-session", sessionId: "missing-live", status: "running", description: "missing", subagentType: "test-agent", themeId: "dracula" }));
    const settledSnapshot = { status: "completed", settled: true, transcript: [{ id: "tool", kind: "tool", toolName: "read", text: "done", complete: true }], counters: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 } };
    pool.registry.createJob(createJob({ jobId: "settled", parentSessionId: "root-session", sessionId: "settled", status: "completed", description: "settled", subagentType: "test-agent", themeId: "dracula" }));
    pool.retainedLiveSnapshots.set("settled", settledSnapshot);
    const mode = hostMode(current, calls);
    const tui = { terminal: { rows: 24, columns: 100 }, requestRender() {}, _hostInteractiveMode: mode, _hostGetThemeInstance: () => current.value };
    const footer = getFooterFactory()(tui, { fg: (_c, text) => text }, { onBranchChange: () => () => {}, getGitBranch: () => "main", getAvailableProviderCount: () => 1 });
    footer.handleInput(ALT_DOWN); footer.handleInput(ALT_DOWN); footer.handleInput(ENTER);
    assert.equal(calls.some((entry) => entry.type === "theme"), false);
    assert.equal(mode.hostSwapDepth(), 0);
    footer.handleInput(ALT_DOWN); footer.handleInput(ALT_DOWN); footer.handleInput(ALT_DOWN); footer.handleInput(ENTER);
    assert.equal(current.value.name, "Dracula");
    assert.equal(mode.hostSwapDepth(), 1);
    footer.dispose();
    assert.equal(mode.hostSwapDepth(), 0);
    assert.equal(current.value, parent);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a host footer reset disposes the old theme frame before reinstalling", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-theme-reset-"));
  try {
    const parent = createNativeTheme(BUILTIN_THEME_PROFILES[0]);
    const current = { value: parent };
    const calls = [];
    const d = piDouble();
    const { ctx, getFooterFactory } = context(cwd, current, calls);
    register(d, ctx);
    const pool = getChildPool(cwd, "root-session");
    const feed = { snapshot: { status: "running", settled: false, transcript: [], counters: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 } }, subscribe: () => () => {}, steer: async () => {} };
    pool.liveChildren.set("reset-child", { sessionFile: join(cwd, "child.jsonl"), live: feed, steer: async () => {}, abort: async () => {} });
    pool.registry.createJob(createJob({ jobId: "reset-child", parentSessionId: "root-session", sessionId: "reset-child", status: "running", description: "reset", subagentType: "test-agent", themeId: "dracula" }));
    const mode1 = hostMode(current, calls);
    const tui1 = { terminal: { rows: 24, columns: 100 }, requestRender() {}, _hostInteractiveMode: mode1, _hostGetThemeInstance: () => current.value };
    const footer1 = getFooterFactory()(tui1, { fg: (_c, text) => text }, { onBranchChange: () => () => {}, getGitBranch: () => "main", getAvailableProviderCount: () => 1 });
    footer1.handleInput(ALT_DOWN); footer1.handleInput(ALT_DOWN); footer1.handleInput(ENTER);
    assert.equal(mode1.hostSwapDepth(), 1);
    footer1.dispose();
    assert.equal(mode1.hostSwapDepth(), 0);
    assert.equal(current.value, parent);
    const mode2 = hostMode(current, calls);
    const tui2 = { terminal: { rows: 24, columns: 100 }, requestRender() {}, _hostInteractiveMode: mode2, _hostGetThemeInstance: () => current.value };
    const footer2 = getFooterFactory()(tui2, { fg: (_c, text) => text }, { onBranchChange: () => () => {}, getGitBranch: () => "main", getAvailableProviderCount: () => 1 });
    footer2.handleInput(ALT_DOWN); footer2.handleInput(ALT_DOWN); footer2.handleInput(ENTER);
    assert.equal(current.value.name, "Dracula");
    footer2.dispose();
    assert.equal(current.value, parent);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a host snapshot failure unwinds the pushed host frame and restores the parent theme", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-theme-fail-"));
  try {
    const parent = createNativeTheme(BUILTIN_THEME_PROFILES[0]);
    const current = { value: parent };
    const calls = [];
    const d = piDouble();
    const { ctx, getFooterFactory } = context(cwd, current, calls);
    register(d, ctx);
    const pool = getChildPool(cwd, "root-session");
    const feed = { snapshot: { status: "running", settled: false, transcript: [], counters: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 } }, subscribe: () => () => {}, steer: async () => {} };
    pool.liveChildren.set("fail-child", { sessionFile: join(cwd, "child.jsonl"), live: feed, steer: async () => {}, abort: async () => {} });
    pool.registry.createJob(createJob({ jobId: "fail-child", parentSessionId: "root-session", sessionId: "fail-child", status: "running", description: "fail", subagentType: "test-agent", themeId: "dracula" }));
    const mode = hostMode(current, calls, { failSnapshotAfterPush: true, recordParentRebuild: true });
    const tui = { terminal: { rows: 24, columns: 100 }, requestRender() {}, _hostInteractiveMode: mode, _hostGetThemeInstance: () => current.value };
    const footer = getFooterFactory()(tui, { fg: (_c, text) => text }, { onBranchChange: () => () => {}, getGitBranch: () => "main", getAvailableProviderCount: () => 1 });
    footer.handleInput(ALT_DOWN); footer.handleInput(ALT_DOWN); footer.handleInput(ENTER);
    assert.equal(mode.hostSwapDepth(), 0);
    assert.equal(current.value, parent);
    // The host rebuilds the parent transcript during frame unwinding, so the
    // parent theme must be restored before that rebuild, not after.
    const themeRestoreIdx = calls.findIndex((entry) => entry.type === "theme" && entry.theme === parent);
    const rebuildIdx = calls.findIndex((entry) => entry.type === "parent-rebuild");
    assert.ok(themeRestoreIdx !== -1, "error path must restore the parent theme");
    assert.ok(rebuildIdx !== -1, "host unwind must rebuild the parent");
    assert.ok(themeRestoreIdx < rebuildIdx, "theme restoration must precede the parent rebuild");
    assert.equal(rebuildIdx >= 0 ? calls[rebuildIdx]?.theme : undefined, parent);
    footer.dispose();
    assert.equal(mode.hostSwapDepth(), 0);
    assert.equal(current.value, parent);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("profile refresh while viewing a nested legacy child rebuilds the visible transcript", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-theme-nested-refresh-"));
  const original = loadThemeLibrary();
  try {
    const parent = createNativeTheme(BUILTIN_THEME_PROFILES[0]);
    const current = { value: parent };
    const calls = [];
    const d = piDouble();
    const { ctx, getFooterFactory } = context(cwd, current, calls);
    register(d, ctx);
    const pool = getChildPool(cwd, "root-session");
    const outerFeed = { snapshot: { status: "running", settled: false, transcript: [{ id: "outer", kind: "message", role: "assistant", text: "outer-text", complete: true }], counters: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 } }, subscribe: () => () => {}, steer: async () => {} };
    const innerFeed = { snapshot: { status: "running", settled: false, transcript: [{ id: "inner", kind: "message", role: "assistant", text: "inner-text", complete: true }], counters: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 } }, subscribe: () => () => {}, steer: async () => {} };
    pool.liveChildren.set("outer-child", { sessionFile: join(cwd, "outer.jsonl"), live: outerFeed, steer: async () => {}, abort: async () => {} });
    pool.liveChildren.set("inner-child", { sessionFile: join(cwd, "inner.jsonl"), live: innerFeed, steer: async () => {}, abort: async () => {} });
    pool.registry.createJob(createJob({ jobId: "outer-child", parentSessionId: "root-session", sessionId: "outer-child", status: "running", description: "outer", subagentType: "test-agent", themeId: "dracula" }));
    pool.registry.createJob(createJob({ jobId: "inner-child", parentSessionId: "outer-child", sessionId: "inner-child", status: "running", description: "inner", subagentType: "test-agent" }));
    const mode = hostMode(current, calls);
    const tui = { terminal: { rows: 24, columns: 100 }, requestRender() {}, _hostInteractiveMode: mode, _hostGetThemeInstance: () => current.value };
    const footer = getFooterFactory()(tui, { fg: (_c, text) => text }, { onBranchChange: () => () => {}, getGitBranch: () => "main", getAvailableProviderCount: () => 1 });
    footer.handleInput(ALT_DOWN); footer.handleInput(ALT_DOWN); footer.handleInput(ENTER);
    footer.handleInput(ALT_DOWN); footer.handleInput(ALT_DOWN); footer.handleInput(ENTER);
    assert.equal(mode.hostSwapDepth(), 2);
    const library = JSON.parse(JSON.stringify(original));
    const themed = library.profiles.find((profile) => profile.themeId === "dracula");
    themed.colors.accent = "#654321";
    writeFileSync(homeThemesFile(), JSON.stringify(library));
    clearThemeLibraryCache();
    footer.render(100);
    const updates = calls.filter((entry) => entry.type === "update");
    assert.equal(updates.length > 0, true);
    assert.equal(updates.at(-1)?.snapshot?.transcript?.[0]?.text, "inner-text");
    footer.dispose();
    assert.equal(current.value, parent);
  } finally {
    writeFileSync(homeThemesFile(), JSON.stringify(original));
    clearThemeLibraryCache();
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
    pool.registry.createJob(createJob({ jobId: "refresh-child", parentSessionId: "root-session", sessionId: "refresh-child", status: "running", description: "refresh", subagentType: "test-agent", themeId: "dracula" }));
    const mode = hostMode(current, calls);
    const tui = { terminal: { rows: 24, columns: 100 }, requestRender() {}, _hostInteractiveMode: mode, _hostGetThemeInstance: () => current.value };
    const footer = getFooterFactory()(tui, { fg: (_c, text) => text }, { onBranchChange: () => () => {}, getGitBranch: () => "main", getAvailableProviderCount: () => 1 });
    footer.handleInput(ALT_DOWN); footer.handleInput(ALT_DOWN); footer.handleInput(ENTER);
    const library = JSON.parse(JSON.stringify(original));
    const themed = library.profiles.find((profile) => profile.themeId === "dracula");
    themed.colors.accent = "#123456";
    writeFileSync(homeThemesFile(), JSON.stringify(library));
    clearThemeLibraryCache();
    footer.render(100);
    assert.equal(calls.some((entry) => entry.type === "update"), true);
    assert.equal(calls.at(-1)?.type, "update");
    assert.equal(calls.at(-1)?.theme.name, "Dracula");
    footer.dispose();
  } finally {
    writeFileSync(homeThemesFile(), JSON.stringify(original));
    clearThemeLibraryCache();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an unpatched host never mutates themes while native child viewing still works", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-theme-degraded-"));
  try {
    const parent = createNativeTheme(BUILTIN_THEME_PROFILES[0]);
    const current = { value: parent };
    const calls = [];
    const d = piDouble();
    const { ctx, getFooterFactory } = context(cwd, current, calls);
    register(d, ctx);
    const pool = getChildPool(cwd, "root-session");
    const feed = { snapshot: { status: "running", settled: false, transcript: [{ id: "m", kind: "message", role: "assistant", text: "child", complete: true }], counters: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 } }, subscribe: () => () => {}, steer: async () => {} };
    pool.liveChildren.set("degraded-child", { sessionFile: join(cwd, "child.jsonl"), live: feed, steer: async () => {}, abort: async () => {} });
    pool.registry.createJob(createJob({ jobId: "degraded-child", parentSessionId: "root-session", sessionId: "degraded-child", status: "running", description: "degraded", subagentType: "test-agent", themeId: "dracula" }));
    const mode = hostMode(current, calls);
    // A stock/unpatched host TUI exposes neither _hostGetThemeInstance nor getTheme.
    const tui = { terminal: { rows: 24, columns: 100 }, requestRender() {}, _hostInteractiveMode: mode };
    const footer = getFooterFactory()(tui, { fg: (_c, text) => text }, { onBranchChange: () => () => {}, getGitBranch: () => "main", getAvailableProviderCount: () => 1 });
    footer.handleInput(ALT_DOWN); footer.handleInput(ALT_DOWN); footer.handleInput(ENTER);
    assert.equal(calls.some((entry) => entry.type === "theme"), false);
    assert.equal(current.value, parent);
    assert.equal(mode.hostSwapDepth(), 1);
    footer.dispose();
    assert.equal(mode.hostSwapDepth(), 0);
    assert.equal(current.value, parent);
  } finally {
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
