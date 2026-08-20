// @ts-nocheck
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createChildLiveFeed, createJob } from "@xzy-ai/core";
import { getChildPool } from "@xzy-ai/runtime";
import { registerAgentFooter } from "../src/registrations/footer.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALT_DOWN = "\x1bn";
const ALT_LEFT = "\x1bb";
const ENTER = "\r";

test("phase2 red: footer wiring uses host swap primitive instead of overlay for main window", () => {
  const footerSource = readFileSync(join(__dirname, "../src/registrations/footer.ts"), "utf8");
  assert.match(footerSource, /hostSwap|HostSwap|_hostSwapStack|createHostSwapController/, "footer should be wired to host swap primitive, not just overlay");
  const hasHostSwapWiring = /createHostSwapController|_hostSwapStack/.test(footerSource);
  assert.ok(hasHostSwapWiring, "footer must use host swap controller");
});

test("phase2: Alt+Left via terminal pops running host-swapped child and clears hint", () => {
  const cwd = mkdtempSync(join(tmpdir(), "probe-"));
  let capturedFooterFactory, capturedCustomFactory, terminalInputHandler;
  function recordedCustom(factory, options) { capturedCustomFactory = factory; return Promise.resolve(undefined); }
  function recordedOnTerminalInput(handler) { terminalInputHandler = handler; return () => {}; }
  function recordedSetFooter(factory) { capturedFooterFactory = factory; }
  const ctx = { mode: "tui", hasUI: true, cwd, model: undefined, getContextUsage: () => undefined, ui: { setFooter: recordedSetFooter, onTerminalInput: recordedOnTerminalInput, custom: recordedCustom, confirm: async () => true }, sessionManager: { getSessionId: () => "root-session", getSessionFile: () => join(cwd, "sessions", "root-session.jsonl"), getLeafId: () => undefined, getSessionName: () => undefined, getCwd: () => cwd, getEntries: () => [] } };
  const pi = { on(event, handler) { pi._h.set(event, handler); }, _h: new Map() };
  registerAgentFooter(pi);
  pi._h.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
  const pool = getChildPool(cwd, "root-session");
  const feed = createChildLiveFeed();
  pool.liveChildren.set("job-a", { sessionFile: join(cwd, "sessions", "job-a.jsonl"), live: feed, steer: async () => {}, abort: async () => {} });
  pool.registry.createJob(createJob({ jobId: "job-a", parentSessionId: "root-session", sessionId: "job-a", status: "running", description: "running A", subagentType: "test-agent" }));
  const tui = { requestRender: () => {}, terminal: { rows: 24, columns: 100 } };
  const footerData = { onBranchChange: () => () => {}, getGitBranch: () => "main", getAvailableProviderCount: () => 1 };
  const footer = capturedFooterFactory(tui, { fg: (_c, t) => t }, footerData);
  footer.handleInput(ALT_DOWN); footer.handleInput(ALT_DOWN); footer.handleInput(ENTER);
  assert.ok(footer.render(100).join("\n").includes("Viewing"), "should be viewing after push");
  const res = terminalInputHandler(ALT_LEFT);
  assert.equal(res.consume, true, "Alt+Left should be consumed for running");
  assert.equal(footer.render(100).join("\n").includes("Viewing"), false, "hint cleared after Alt+Left pop");
  rmSync(cwd, { recursive: true, force: true });
});

test("phase2: Alt+Left on settled child pops via host swap and clears hint (F1)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "probe-"));
  let capturedFooterFactory, capturedCustomFactory, terminalInputHandler;
  function recordedCustom(factory, options) { capturedCustomFactory = factory; return Promise.resolve(undefined); }
  function recordedOnTerminalInput(handler) { terminalInputHandler = handler; return () => {}; }
  function recordedSetFooter(factory) { capturedFooterFactory = factory; }
  const ctx = { mode: "tui", hasUI: true, cwd, model: undefined, getContextUsage: () => undefined, ui: { setFooter: recordedSetFooter, onTerminalInput: recordedOnTerminalInput, custom: recordedCustom, confirm: async () => true }, sessionManager: { getSessionId: () => "root-session", getSessionFile: () => join(cwd, "sessions", "root-session.jsonl"), getLeafId: () => undefined, getSessionName: () => undefined, getCwd: () => cwd, getEntries: () => [] } };
  const pi = { on(event, handler) { pi._h.set(event, handler); }, _h: new Map() };
  registerAgentFooter(pi);
  pi._h.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
  const pool = getChildPool(cwd, "root-session");
  const feed = createChildLiveFeed();
  feed.emit({ type: "message", id: "m1", phase: "end", role: "assistant", text: "done" });
  feed.emit({ type: "settled", status: "completed" });
  (pool.retainedLiveSnapshots).set("job-c", feed.snapshot);
  pool.registry.createJob({ ...createJob({ jobId: "job-c", parentSessionId: "root-session", sessionId: "job-c", status: "completed", description: "completed C", subagentType: "test-agent" }), updatedAt: new Date().toISOString() });
  const tui = { requestRender: () => {}, terminal: { rows: 24, columns: 100 } };
  const footerData = { onBranchChange: () => () => {}, getGitBranch: () => "main", getAvailableProviderCount: () => 1 };
  const footer = capturedFooterFactory(tui, { fg: (_c, t) => t }, footerData);
  footer.handleInput(ALT_DOWN); footer.handleInput(ALT_DOWN); footer.handleInput(ENTER);
  assert.equal(capturedCustomFactory, undefined, "settled should not mount overlay; parent window reused");
  assert.ok(footer.render(100).join("\n").includes("Viewing"), "should be viewing settled");
  const res = terminalInputHandler(ALT_LEFT);
  assert.equal(res.consume, true, "settled Alt+Left should be consumed via host swap (parent window)");
  assert.equal(footer.render(100).join("\n").includes("Viewing"), false, "hint cleared after Alt+Left pop");
  rmSync(cwd, { recursive: true, force: true });
});
