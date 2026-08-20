// @ts-nocheck
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createChildLiveFeed, createJob } from "@xzy-ai/core";
import { getChildPool } from "@xzy-ai/runtime";
import { registerAgentFooter } from "../src/registrations/footer.ts";

const ALT_DOWN = "\x1bn";
const ALT_LEFT = "\x1bb";
const ENTER = "\r";

let capturedFooterFactory: any;
let capturedCustomFactory: any;
let terminalInputHandler: any;
function recordedCustom(factory: unknown, options?: unknown): Promise<unknown> {
  capturedCustomFactory = factory;
  return Promise.resolve(undefined);
}
function recordedOnTerminalInput(handler: any): () => void {
  terminalInputHandler = handler;
  return () => { if (terminalInputHandler === handler) terminalInputHandler = undefined; };
}
function recordedSetFooter(factory: any) { capturedFooterFactory = factory; }
function ctx(cwd: string, sessionId = "root-session", mode = "tui", hasUI = true): ExtensionContext {
  return {
    mode,
    hasUI,
    cwd,
    model: undefined,
    getContextUsage: () => undefined,
    ui: {
      setFooter: recordedSetFooter,
      onTerminalInput: recordedOnTerminalInput,
      custom: recordedCustom,
      confirm: async () => true,
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => join(cwd, "sessions", `${sessionId}.jsonl`),
      getLeafId: () => undefined,
      getSessionName: () => undefined,
      getCwd: () => cwd,
      getEntries: () => [{ type: "message", message: { role: "user", content: "hello" } }],
    } as unknown as ExtensionContext["sessionManager"],
  } as unknown as ExtensionContext;
}
function piDouble(): { pi: ExtensionAPI; handlers: Map<string, any>; } {
  const handlers = new Map<string, any>();
  return { handlers, pi: { on(event: string, handler: any) { handlers.set(event, handler); } } as unknown as ExtensionAPI };
}

test("phase4: returning via Alt+Left requests render and re-projects footer to root", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-return-"));
  try {
    capturedFooterFactory = undefined;
    capturedCustomFactory = undefined;
    const d = piDouble();
    const testCtx = ctx(cwd);
    registerAgentFooter(d.pi);
    d.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, testCtx);
    const pool = getChildPool(cwd, "root-session");
    const feedA = createChildLiveFeed();
    feedA.emit({ type: "message", id: "m1", phase: "end", role: "assistant", text: "child A" });
    pool.liveChildren.set("job-a", { sessionFile: join(cwd, "sessions", "job-a.jsonl"), live: feedA, steer: async () => {}, abort: async () => {} });
    pool.registry.createJob(createJob({ jobId: "job-a", parentSessionId: "root-session", sessionId: "job-a", status: "running", description: "child A", subagentType: "test-agent" }));

    let renderCalls = 0;
    const tui = { requestRender: () => { renderCalls++; }, terminal: { rows: 24, columns: 100 } };
    const footerData = { onBranchChange: () => () => {}, getGitBranch: () => "main", getAvailableProviderCount: () => 1 };
    let footer = capturedFooterFactory!(tui, { fg: (_c: string, t: string) => t }, footerData) as any;

    footer.handleInput(ALT_DOWN);
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ENTER);
    assert.equal(capturedCustomFactory, undefined, "host-level: no overlay");
    assert.ok(footer.render(100).join("\n").includes("Viewing"), "should be viewing");

    const callsBeforeReturn = renderCalls;
    const res = terminalInputHandler(ALT_LEFT);
    assert.equal(res.consume, true, "Alt+Left should be consumed");
    assert.ok(renderCalls > callsBeforeReturn, "return via Alt+Left should request render");
    const rowsAtRoot = footer.render(100).join("\n");
    assert.ok(rowsAtRoot.includes("child A"), "after return, footer at root shows child A");
    assert.ok(!rowsAtRoot.includes("Viewing job-a"), "stack should be cleared");

    footer.dispose();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    capturedFooterFactory = undefined;
    capturedCustomFactory = undefined;
    terminalInputHandler = undefined;
  }
});

test("phase4: returning via parent/main requests render and clears stack", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-return-"));
  try {
    capturedFooterFactory = undefined;
    capturedCustomFactory = undefined;
    const d = piDouble();
    const testCtx = ctx(cwd);
    registerAgentFooter(d.pi);
    d.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, testCtx);
    const pool = getChildPool(cwd, "root-session");
    const feedA = createChildLiveFeed();
    const feedC = createChildLiveFeed();
    pool.liveChildren.set("job-a", { sessionFile: join(cwd, "sessions", "job-a.jsonl"), live: feedA, steer: async () => {}, abort: async () => {} });
    pool.liveChildren.set("job-c", { sessionFile: join(cwd, "sessions", "job-c.jsonl"), live: feedC, steer: async () => {}, abort: async () => {} });
    pool.registry.createJob(createJob({ jobId: "job-a", parentSessionId: "root-session", sessionId: "job-a", status: "running", description: "child A", subagentType: "test-agent" }));
    pool.registry.createJob(createJob({ jobId: "job-c", parentSessionId: "job-a", sessionId: "job-c", status: "running", description: "grandchild C", subagentType: "test-agent" }));

    let renderCalls = 0;
    const tui = { requestRender: () => { renderCalls++; }, terminal: { rows: 24, columns: 100 } };
    const footerData = { onBranchChange: () => () => {}, getGitBranch: () => "main", getAvailableProviderCount: () => 1 };
    let footer = capturedFooterFactory!(tui, { fg: (_c: string, t: string) => t }, footerData) as any;

    footer.handleInput(ALT_DOWN);
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ENTER);
    assert.equal(capturedCustomFactory, undefined, "host-level: no overlay for job-a");
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ENTER);
    assert.equal(capturedCustomFactory, undefined, "host-level: no overlay for grandchild");

    const callsBefore = renderCalls;
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ENTER);
    assert.ok(renderCalls > callsBefore, "return via parent/main should request render");
    const rowsAtRoot = footer.render(100).join("\n");
    assert.ok(rowsAtRoot.includes("child A"), "after return, footer at root shows child A");
    assert.ok(!rowsAtRoot.includes("Viewing"), "hint should be cleared after return");

    footer.dispose();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    capturedFooterFactory = undefined;
    capturedCustomFactory = undefined;
    terminalInputHandler = undefined;
  }
});

test("phase4: swapping to a leaf with no descendants renders root anchor and parent/main returns to root", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-return-"));
  try {
    capturedFooterFactory = undefined;
    capturedCustomFactory = undefined;
    const d = piDouble();
    const testCtx = ctx(cwd);
    registerAgentFooter(d.pi);
    d.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, testCtx);
    const pool = getChildPool(cwd, "root-session");
    const feedA = createChildLiveFeed();
    pool.liveChildren.set("job-a", { sessionFile: join(cwd, "sessions", "job-a.jsonl"), live: feedA, steer: async () => {}, abort: async () => {} });
    pool.registry.createJob(createJob({ jobId: "job-a", parentSessionId: "root-session", sessionId: "job-a", status: "running", description: "child A", subagentType: "test-agent" }));

    let renderCalls = 0;
    const tui = { requestRender: () => { renderCalls++; }, terminal: { rows: 24, columns: 100 } };
    const footerData = { onBranchChange: () => () => {}, getGitBranch: () => "main", getAvailableProviderCount: () => 1 };
    let footer = capturedFooterFactory!(tui, { fg: (_c: string, t: string) => t }, footerData) as any;

    footer.handleInput(ALT_DOWN);
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ENTER);
    assert.equal(capturedCustomFactory, undefined, "host-level: no overlay for leaf");
    const whileViewing = footer.render(100).join("\n");
    assert.ok(whileViewing.includes("main (job-a)"), "leaf swapped footer should render root anchor main (job-a)");
    assert.ok(whileViewing.includes("Viewing"), "leaf swapped footer should show viewing hint");

    const callsBefore = renderCalls;
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ENTER);
    assert.ok(renderCalls > callsBefore, "leaf return should request render");
    const after = footer.render(100).join("\n");
    assert.ok(after.includes("child A"), "after leaf return, footer at root shows child A");
    assert.ok(!after.includes("Viewing job-a"), "hint cleared after leaf return");

    footer.dispose();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    capturedFooterFactory = undefined;
    capturedCustomFactory = undefined;
    terminalInputHandler = undefined;
  }
});

test("phase4: non-TUI modes never show swap UI", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-return-"));
  try {
    capturedFooterFactory = undefined;
    capturedCustomFactory = undefined;
    const d = piDouble();
    registerAgentFooter(d.pi);
    d.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx(cwd, "root-session", "headless", false));
    assert.equal(capturedFooterFactory, undefined, "non-TUI mode should not set footer");
    capturedFooterFactory = undefined;
    d.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx(cwd, "root-session", "tui", false));
    assert.equal(capturedFooterFactory, undefined, "hasUI false should not set footer");

    const pool = getChildPool(cwd, "root-session");
    const feed = createChildLiveFeed();
    pool.liveChildren.set("job-a", { sessionFile: join(cwd, "sessions", "job-a.jsonl"), live: feed, steer: async () => {}, abort: async () => {} });
    pool.registry.createJob(createJob({ jobId: "job-a", parentSessionId: "root-session", sessionId: "job-a", status: "running", description: "child A", subagentType: "test-agent" }));
    assert.equal(capturedCustomFactory, undefined, "non-TUI should not have mounted swap");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    capturedFooterFactory = undefined;
    capturedCustomFactory = undefined;
    terminalInputHandler = undefined;
  }
});

test("phase4: while viewing child, background parent output does not auto-return", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-return-"));
  try {
    capturedFooterFactory = undefined;
    capturedCustomFactory = undefined;
    const d = piDouble();
    const testCtx = ctx(cwd);
    registerAgentFooter(d.pi);
    d.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, testCtx);
    const pool = getChildPool(cwd, "root-session");
    const feedA = createChildLiveFeed();
    pool.liveChildren.set("job-a", { sessionFile: join(cwd, "sessions", "job-a.jsonl"), live: feedA, steer: async () => {}, abort: async () => {} });
    pool.registry.createJob(createJob({ jobId: "job-a", parentSessionId: "root-session", sessionId: "job-a", status: "running", description: "child A", subagentType: "test-agent" }));

    const tui = { requestRender: () => {}, terminal: { rows: 24, columns: 100 } };
    const footerData = { onBranchChange: () => () => {}, getGitBranch: () => "main", getAvailableProviderCount: () => 1 };
    let footer = capturedFooterFactory!(tui, { fg: (_c: string, t: string) => t }, footerData) as any;

    footer.handleInput(ALT_DOWN);
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ENTER);
    assert.equal(capturedCustomFactory, undefined, "host-level: no overlay");
    assert.ok(footer.render(100).join("\n").includes("Viewing"), "footer should show viewing hint");

    await new Promise((r) => setTimeout(r, 10));
    const rowsWhileViewing = footer.render(100).join("\n");
    assert.ok(rowsWhileViewing.includes("Viewing"), "footer should still show viewing hint, not auto-returned");
    assert.ok(rowsWhileViewing.includes("job-a") || rowsWhileViewing.includes("Viewing a"), "hint should reference job-a");

    footer.dispose();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    capturedFooterFactory = undefined;
    capturedCustomFactory = undefined;
    terminalInputHandler = undefined;
  }
});
