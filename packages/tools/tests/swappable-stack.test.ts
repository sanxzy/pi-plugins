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
    registerAgentFooter(d.pi);
    d.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx(cwd));
    const pool = getChildPool(cwd, "root-session");
    const feedA = createChildLiveFeed();
    const feedB = createChildLiveFeed();
    const feedC = createChildLiveFeed();
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
    assert.ok(capturedCustomFactory, "should mount swap for job-a");
    const rowsAfter = footer.render(100).join("\n");
    const hasSibling = rowsAfter.includes("sibling B");
    const hasGrandchild = rowsAfter.includes("grandchild C");
    assert.equal(hasSibling, false, "while viewing child A, footer must hide sibling B. Got rows:\n" + rowsAfter);
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
    registerAgentFooter(d.pi);
    d.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx(cwd));
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

    // Select job-a
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ENTER);
    assert.ok(capturedCustomFactory, "mounted job-a");
    const firstFactory = capturedCustomFactory;
    let hostDoneCallsA = 0;
    const swapA = firstFactory({ requestRender: () => {}, terminal: { rows: 24, columns: 100 } }, { fg: (_c: string, t: string) => t }, {}, () => { hostDoneCallsA++; }) as any;

    // While viewing job-a, footer should show grandchild C and great-grandchild D, not sibling
    let rowsAfterFirst = footer.render(100).join("\n");
    assert.ok(rowsAfterFirst.includes("grandchild C"), "after viewing A, footer shows C. Got:\n" + rowsAfterFirst);
    assert.ok(rowsAfterFirst.includes("great-grandchild D"), "after viewing A, footer shows D. Got:\n" + rowsAfterFirst);

    // Select grandchild C from footer (now at depth 1, index 1)
    // Footer rows after viewing A: root (main (job-a)) index 0, C index 1, D index 2
    // Need to enter management and move to C
    footer.handleInput(ALT_DOWN); // enter management (selected 0)
    footer.handleInput(ALT_DOWN); // move to C (index 1)
    footer.handleInput(ENTER); // select C
    assert.ok(capturedCustomFactory, "should have captured second factory");
    const secondFactory = capturedCustomFactory;
    assert.notEqual(secondFactory, firstFactory, "second swap should be different factory");
    let hostDoneCallsC = 0;
    const swapC = secondFactory({ requestRender: () => {}, terminal: { rows: 24, columns: 100 } }, { fg: (_c: string, t: string) => t }, {}, () => { hostDoneCallsC++; }) as any;

    // Footer should now re-project to C's descendants (only D)
    const rowsAfterSecond = footer.render(100).join("\n");
    assert.ok(rowsAfterSecond.includes("great-grandchild D"), "after viewing C, footer shows D. Got:\n" + rowsAfterSecond);
    // C itself should not appear as descendant (it's the focus), only D
    // The root should be main (job-c)
    assert.ok(rowsAfterSecond.includes("main"), "root should be main");
    // Ensure first swap still mounted (hostDone for A not called)
    assert.equal(hostDoneCallsA, 0, "first swap should still be mounted");
    assert.equal(hostDoneCallsC, 0, "second swap should be mounted");

    swapC.dispose?.();
    swapA.dispose?.();
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
    registerAgentFooter(d.pi);
    d.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx(cwd));
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
    assert.ok(capturedCustomFactory, "mounted job-a");
    const factoryA = capturedCustomFactory;
    let hostDoneA = 0;
    const swapA = factoryA({ requestRender: () => {}, terminal: { rows: 24, columns: 100 } }, { fg: (_c: string, t: string) => t }, {}, () => { hostDoneA++; }) as any;

    // Push C
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ENTER);
    assert.ok(capturedCustomFactory, "mounted job-c");
    const factoryC = capturedCustomFactory;
    let hostDoneC = 0;
    const swapC = factoryC({ requestRender: () => {}, terminal: { rows: 24, columns: 100 } }, { fg: (_c: string, t: string) => t }, {}, () => { hostDoneC++; }) as any;

    // Now at depth 2 (A -> C). Footer should show D.
    let rowsAtDepth2 = footer.render(100).join("\n");
    assert.ok(rowsAtDepth2.includes("great-grandchild D"), "at depth 2, footer shows D");

    // Alt+Left on top swap (C) should pop one level
    swapC.handleInput(ALT_LEFT);
    // Host done for C should have been called, A's not yet
    assert.equal(hostDoneC, 1, "Alt+Left should close top swap (C)");
    assert.equal(hostDoneA, 0, "A should remain mounted after pop");

    // Footer should re-project to A's descendants (C and D)
    const rowsAfterPop = footer.render(100).join("\n");
    assert.ok(rowsAfterPop.includes("grandchild C"), "after pop, footer shows C again. Got:\n" + rowsAfterPop);
    assert.ok(rowsAfterPop.includes("great-grandchild D"), "after pop, footer shows D again");

    // Another Alt+Left should pop to root
    swapA.handleInput(ALT_LEFT);
    assert.equal(hostDoneA, 1, "second Alt+Left should close A");
    const rowsAtRoot = footer.render(100).join("\n");
    assert.ok(rowsAtRoot.includes("child A"), "at root, footer shows child A");

    swapC.dispose?.();
    swapA.dispose?.();
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
    registerAgentFooter(d.pi);
    d.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx(cwd));
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
    assert.ok(capturedCustomFactory);
    const factoryA = capturedCustomFactory;
    let hostDoneA = 0;
    const swapA = factoryA({ requestRender: () => {}, terminal: { rows: 24, columns: 100 } }, { fg: (_c: string, t: string) => t }, {}, () => { hostDoneA++; }) as any;
    // Push C
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ALT_DOWN);
    footer.handleInput(ENTER);
    assert.ok(capturedCustomFactory);
    const factoryC = capturedCustomFactory;
    let hostDoneC = 0;
    const swapC = factoryC({ requestRender: () => {}, terminal: { rows: 24, columns: 100 } }, { fg: (_c: string, t: string) => t }, {}, () => { hostDoneC++; }) as any;

    // Now at depth 2, select root/main to clear all
    footer.handleInput(ALT_DOWN); // enter management, selected 0 = root
    footer.handleInput(ENTER); // select root
    // Both swaps should be closed
    assert.equal(hostDoneC, 1, "selecting root should close C");
    assert.equal(hostDoneA, 1, "selecting root should close A");
    const rowsAtRoot = footer.render(100).join("\n");
    assert.ok(rowsAtRoot.includes("child A"), "after clear, footer shows child A. Got:\n" + rowsAtRoot);
    // While viewing C (depth 2) the footer was scoped to C's descendants (only D);
    // after clear-to-root it must re-project from the root, so C reappears as A's
    // descendant and the focus context has switched back to the root session.
    assert.ok(rowsAtRoot.includes("grandchild C"), "after clear to root, footer re-shows C as A's descendant. Got:\n" + rowsAtRoot);

    swapC.dispose?.();
    swapA.dispose?.();
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
    registerAgentFooter(d.pi);
    d.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx(cwd));
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
    const swap = capturedCustomFactory!({ requestRender: () => {}, terminal: { rows: 24, columns: 100 } }, { fg: (_c: string, t: string) => t }, {}, () => {}) as any;
    // Settle the child while viewed
    feedA.emit({ type: "settled", status: "completed" });
    // Swap should stay open, now read-only, not auto-close
    const lines = swap.render(100).join("\n");
    assert.match(lines, /read-only/, "settled view stays open read-only");
    swap.dispose?.();
    footer.dispose();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    capturedFooterFactory = undefined;
    capturedCustomFactory = undefined;
    terminalInputHandler = undefined;
  }
});
