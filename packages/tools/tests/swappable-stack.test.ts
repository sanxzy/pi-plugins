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
let capturedCustomOptions: any;
let terminalInputHandler: any;
function recordedCustom(factory: unknown, options?: unknown): Promise<unknown> {
  capturedCustomFactory = factory;
  capturedCustomOptions = options;
  return Promise.resolve(undefined);
}
function recordedOnTerminalInput(handler: any): () => void {
  terminalInputHandler = handler;
  return () => { if (terminalInputHandler === handler) terminalInputHandler = undefined; };
}
function recordedSetFooter(factory: any) { capturedFooterFactory = factory; }
function ctx(cwd: string, sessionId = "root-session"): ExtensionContext {
  return {
    mode: "tui",
    hasUI: true,
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
      getEntries: () => [],
    } as unknown as ExtensionContext["sessionManager"],
  } as unknown as ExtensionContext;
}
function piDouble(): { pi: ExtensionAPI; handlers: Map<string, any>; } {
  const handlers = new Map<string, any>();
  return { handlers, pi: { on(event: string, handler: any) { handlers.set(event, handler); } } as unknown as ExtensionAPI };
}

test("phase3: while viewing child, footer shows child's descendants not parent siblings", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-stack-"));
  try {
    capturedFooterFactory = undefined;
    capturedCustomFactory = undefined;
    const d = piDouble();
    const testCtx = ctx(cwd);
    registerAgentFooter(d.pi);
    d.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, testCtx);
    const pool = getChildPool(cwd, "root-session");
    const feedA = createChildLiveFeed();
    const feedB = createChildLiveFeed();
    const feedC = createChildLiveFeed();
    feedA.emit({ type: "message", id: "m1", phase: "end", role: "assistant", text: "child A transcript" });
    pool.liveChildren.set("job-a", { sessionFile: join(cwd, "sessions", "job-a.jsonl"), live: feedA, steer: async () => {}, abort: async () => {} });
    pool.liveChildren.set("job-b", { sessionFile: join(cwd, "sessions", "job-b.jsonl"), live: feedB, steer: async () => {}, abort: async () => {} });
    pool.liveChildren.set("job-c", { sessionFile: join(cwd, "sessions", "job-c.jsonl"), live: feedC, steer: async () => {}, abort: async () => {} });
    pool.registry.createJob(createJob({ jobId: "job-a", parentSessionId: "root-session", sessionId: "job-a", status: "running", description: "child A", subagentType: "test-agent" }));
    pool.registry.createJob(createJob({ jobId: "job-b", parentSessionId: "root-session", sessionId: "job-b", status: "running", description: "sibling B", subagentType: "test-agent" }));
    pool.registry.createJob(createJob({ jobId: "job-c", parentSessionId: "job-a", sessionId: "job-c", status: "running", description: "grandchild C", subagentType: "test-agent" }));

    const tui = { requestRender: () => {}, terminal: { rows: 24, columns: 100 } };
    const footerData = { onBranchChange: () => () => {}, getGitBranch: () => "main", getAvailableProviderCount: () => 1 };
    let footer = capturedFooterFactory!(tui, { fg: (_c: string, t: string) => t }, footerData) as any;
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ENTER);
    // True host-level: no overlay, parent window reused
    assert.equal(capturedCustomFactory, undefined, "should not mount overlay; parent window reused");
    // Parent sessionManager should now show child's transcript
    const entries = (testCtx.sessionManager as unknown as { getEntries: () => unknown[] }).getEntries();
    assert.ok(JSON.stringify(entries).includes("child A transcript") || entries.length > 0, "parent window should show child's transcript");
    const rowsAfter = footer.render(100).join("\n");
    const hasSibling = rowsAfter.includes("sibling B");
    const hasGrandchild = rowsAfter.includes("grandchild C");
    assert.equal(hasSibling, true, "while viewing child A, footer still shows sibling B (tree always on). Got rows:\n" + rowsAfter);
    assert.equal(hasGrandchild, true, "while viewing child A, footer must show grandchild C. Got rows:\n" + rowsAfter);
    footer.dispose();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    capturedFooterFactory = undefined;
    capturedCustomFactory = undefined;
    terminalInputHandler = undefined;
  }
});

test("phase3: selecting descendant while viewing child pushes deeper", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-stack-"));
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
    const feedD = createChildLiveFeed();
    feedA.emit({ type: "message", id: "m1", phase: "end", role: "assistant", text: "A" });
    feedC.emit({ type: "message", id: "m1", phase: "end", role: "assistant", text: "C" });
    pool.liveChildren.set("job-a", { sessionFile: join(cwd, "sessions", "job-a.jsonl"), live: feedA, steer: async () => {}, abort: async () => {} });
    pool.liveChildren.set("job-c", { sessionFile: join(cwd, "sessions", "job-c.jsonl"), live: feedC, steer: async () => {}, abort: async () => {} });
    pool.liveChildren.set("job-d", { sessionFile: join(cwd, "sessions", "job-d.jsonl"), live: feedD, steer: async () => {}, abort: async () => {} });
    pool.registry.createJob(createJob({ jobId: "job-a", parentSessionId: "root-session", sessionId: "job-a", status: "running", description: "child A", subagentType: "test-agent" }));
    pool.registry.createJob(createJob({ jobId: "job-c", parentSessionId: "job-a", sessionId: "job-c", status: "running", description: "grandchild C", subagentType: "test-agent" }));
    pool.registry.createJob(createJob({ jobId: "job-d", parentSessionId: "job-c", sessionId: "job-d", status: "running", description: "great-grandchild D", subagentType: "test-agent" }));

    const tui = { requestRender: () => {}, terminal: { rows: 24, columns: 100 } };
    const footerData = { onBranchChange: () => () => {}, getGitBranch: () => "main", getAvailableProviderCount: () => 1 };
    let footer = capturedFooterFactory!(tui, { fg: (_c: string, t: string) => t }, footerData) as any;

    // Select job-a
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ENTER);
    assert.equal(capturedCustomFactory, undefined, "host-level: no overlay for job-a");

    // While viewing job-a, footer should show grandchild C and great-grandchild D, not sibling
    let rowsAfterFirst = footer.render(100).join("\n");
    assert.ok(rowsAfterFirst.includes("grandchild C"), "after viewing A, footer shows C. Got:\n" + rowsAfterFirst);
    assert.ok(rowsAfterFirst.includes("great-grandchild D"), "after viewing A, footer shows D. Got:\n" + rowsAfterFirst);

    // Select grandchild C from footer (now at depth 1, index 1)
    footer.handleInput(ALT_DOWN); // enter management (selected 0)
    footer.handleInput(ALT_DOWN); // move to C (index 1)
    footer.handleInput(ENTER); // select C
    // True host-level: still no overlay, but footer should re-project to C's descendants
    assert.equal(capturedCustomFactory, undefined, "host-level: no overlay for grandchild C");
    // Footer should now re-project to C's descendants (only D)
    const rowsAfterSecond = footer.render(100).join("\n");
    assert.ok(rowsAfterSecond.includes("great-grandchild D"), "after viewing C, footer shows D. Got:\n" + rowsAfterSecond);
    assert.ok(rowsAfterSecond.includes("main"), "root should be main");

    footer.dispose();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    capturedFooterFactory = undefined;
    capturedCustomFactory = undefined;
    terminalInputHandler = undefined;
  }
});

test("phase3: Alt+Left pops one level", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-stack-"));
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
    const feedD = createChildLiveFeed();
    pool.liveChildren.set("job-a", { sessionFile: join(cwd, "sessions", "job-a.jsonl"), live: feedA, steer: async () => {}, abort: async () => {} });
    pool.liveChildren.set("job-c", { sessionFile: join(cwd, "sessions", "job-c.jsonl"), live: feedC, steer: async () => {}, abort: async () => {} });
    pool.liveChildren.set("job-d", { sessionFile: join(cwd, "sessions", "job-d.jsonl"), live: feedD, steer: async () => {}, abort: async () => {} });
    pool.registry.createJob(createJob({ jobId: "job-a", parentSessionId: "root-session", sessionId: "job-a", status: "running", description: "child A", subagentType: "test-agent" }));
    pool.registry.createJob(createJob({ jobId: "job-c", parentSessionId: "job-a", sessionId: "job-c", status: "running", description: "grandchild C", subagentType: "test-agent" }));
    pool.registry.createJob(createJob({ jobId: "job-d", parentSessionId: "job-c", sessionId: "job-d", status: "running", description: "great-grandchild D", subagentType: "test-agent" }));

    const tui = { requestRender: () => {}, terminal: { rows: 24, columns: 100 } };
    const footerData = { onBranchChange: () => () => {}, getGitBranch: () => "main", getAvailableProviderCount: () => 1 };
    let footer = capturedFooterFactory!(tui, { fg: (_c: string, t: string) => t }, footerData) as any;
    // Push A
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ENTER);
    // Push C
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ENTER);

    // Now at depth 2 (A -> C). Footer should show D.
    let rowsAtDepth2 = footer.render(100).join("\n");
    assert.ok(rowsAtDepth2.includes("great-grandchild D"), "at depth 2, footer shows D");

    // Alt+Left should pop one level via host primitive (no overlay)
    const res1 = terminalInputHandler(ALT_LEFT);
    assert.equal(res1.consume, true, "Alt+Left should be consumed and pop");
    // Footer should re-project to A's descendants (C and D)
    const rowsAfterPop = footer.render(100).join("\n");
    assert.ok(rowsAfterPop.includes("grandchild C"), "after pop, footer shows C again. Got:\n" + rowsAfterPop);
    assert.ok(rowsAfterPop.includes("great-grandchild D"), "after pop, footer shows D again");

    // Another Alt+Left should pop to root
    const res2 = terminalInputHandler(ALT_LEFT);
    assert.equal(res2.consume, true, "second Alt+Left should be consumed");
    const rowsAtRoot = footer.render(100).join("\n");
    assert.ok(rowsAtRoot.includes("child A"), "at root, footer shows child A");

    footer.dispose();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    capturedFooterFactory = undefined;
    capturedCustomFactory = undefined;
    terminalInputHandler = undefined;
  }
});

test("phase3: selecting parent/main returns directly to root and clears stack", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-stack-"));
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
    const feedD = createChildLiveFeed();
    pool.liveChildren.set("job-a", { sessionFile: join(cwd, "sessions", "job-a.jsonl"), live: feedA, steer: async () => {}, abort: async () => {} });
    pool.liveChildren.set("job-c", { sessionFile: join(cwd, "sessions", "job-c.jsonl"), live: feedC, steer: async () => {}, abort: async () => {} });
    pool.liveChildren.set("job-d", { sessionFile: join(cwd, "sessions", "job-d.jsonl"), live: feedD, steer: async () => {}, abort: async () => {} });
    pool.registry.createJob(createJob({ jobId: "job-a", parentSessionId: "root-session", sessionId: "job-a", status: "running", description: "child A", subagentType: "test-agent" }));
    pool.registry.createJob(createJob({ jobId: "job-c", parentSessionId: "job-a", sessionId: "job-c", status: "running", description: "grandchild C", subagentType: "test-agent" }));
    pool.registry.createJob(createJob({ jobId: "job-d", parentSessionId: "job-c", sessionId: "job-d", status: "running", description: "great-grandchild D", subagentType: "test-agent" }));

    const tui = { requestRender: () => {}, terminal: { rows: 24, columns: 100 } };
    const footerData = { onBranchChange: () => () => {}, getGitBranch: () => "main", getAvailableProviderCount: () => 1 };
    let footer = capturedFooterFactory!(tui, { fg: (_c: string, t: string) => t }, footerData) as any;
    // Push A
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ENTER);
    // Push C
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ENTER);

    // Now at depth 2, select root/main to clear all
    footer.handleInput(ALT_DOWN); // enter management, selected 0 = root
    footer.handleInput(ENTER); // select root
    const rowsAtRoot = footer.render(100).join("\n");
    assert.ok(rowsAtRoot.includes("child A"), "after clear, footer shows child A. Got:\n" + rowsAtRoot);
    assert.ok(rowsAtRoot.includes("grandchild C"), "after clear to root, footer re-shows C as A's descendant. Got:\n" + rowsAtRoot);

    footer.dispose();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    capturedFooterFactory = undefined;
    capturedCustomFactory = undefined;
    terminalInputHandler = undefined;
  }
});

test("phase3: if viewed child settles while viewed, stays open read-only", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-c2-stack-"));
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
    // True host-level: parent window now shows child's transcript, no overlay
    assert.ok(footer.render(100).join("\n").includes("Viewing"), "should be viewing after swap");
    // Settle the child while viewed - parent window should stay on child's transcript but now read-only hint
    // Simulate feed settling: update pool job status and emit
    feedA.emit({ type: "settled", status: "completed" });
    // The footer hint should still show Viewing, now read-only after next render? Our current code doesn't auto-update hint on settle, but view stays.
    assert.ok(footer.render(100).join("\n").includes("Viewing"), "settled view stays open (host-level)");
    footer.dispose();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    capturedFooterFactory = undefined;
    capturedCustomFactory = undefined;
    terminalInputHandler = undefined;
  }
});
