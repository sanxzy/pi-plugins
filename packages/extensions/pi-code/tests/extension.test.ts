import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piCodeExtension, { extensionName, type QuestionDetails } from "../index.ts";

/**
 * Phase 4 extension-wiring tests.
 *
 * These codify the phase's acceptance criteria that are verifiable without a
 * live PI host: the composition root registers the `question` tool, the
 * registration stays main-agent-only (nothing is registered for child
 * sessions), and the extension re-exports `QuestionDetails`.
 */
test("pi-code extension registers the goal workflow alongside existing tools", () => {
  const names: string[] = [];
  const commands: string[] = [];
  const pi = {
    registerTool(tool: { name: string }) {
      names.push(tool.name);
    },
    registerShortcut() {},
    registerCommand(name: string) {
      commands.push(name);
    },
    on() {},
    setActiveTools() {},
    getAllTools() {
      return [];
    },
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
  piCodeExtension(pi);
  assert.ok(names.includes("question"), "question tool registered");
  assert.ok(names.includes("agent"), "agent tool registered");
  assert.ok(names.includes("agent_status"), "agent_status tool registered");
  assert.deepEqual(
    names.filter((name) => name.startsWith("goal_")),
    ["goal_create", "goal_pause", "goal_resume", "goal_status", "goal_clear"],
  );
  assert.deepEqual(commands, ["goal"]);
});

test("question registration is main-agent-only (no child tool registrations)", () => {
  const names: string[] = [];
  const pi = {
    registerTool(tool: { name: string }) {
      names.push(tool.name);
    },
    registerShortcut() {},
    registerCommand() {},
    on() {},
    setActiveTools() {},
    getAllTools() {
      return [];
    },
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
  piCodeExtension(pi);
  // Child sessions receive only the built-in allowlist; the extension never
  // registers anything scoped to child sessions, so the question tool (like the
  // other pi-code tools) is structurally main-agent-only.
  assert.deepEqual(names, [
    "question",
    "agent",
    "agent_cancel",
    "agent_status",
    "agent_jobs",
    "goal_create",
    "goal_pause",
    "goal_resume",
    "goal_status",
    "goal_clear",
  ]);
});

test("extension re-exports QuestionDetails", () => {
  const details: QuestionDetails = {
    question: "Proceed?",
    options: ["Yes", "No"],
    answer: "No",
    wasCustom: false,
    index: 2,
  };
  // The re-export is a type-only surface; exercising it through a value keeps
  // the shape contract in sync with the source package.
  assert.equal(extensionName, "pi-code");
  assert.equal(details.options.length, 2);
});
