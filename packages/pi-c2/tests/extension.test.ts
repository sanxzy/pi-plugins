import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { settingsConfigPath } from "@xzy-ai/runtime";
import piC2Extension, {
  extensionName,
  type QuestionDetails,
  type WebFetchDetails,
  type WebSearchDetails,
  type KnowledgeSearchDetails,
} from "../index.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "pi-c2-bootstrap-home-"));
}

function withHome(home: string, run: () => void): void {
  const previous = process.env.PI_C2_TEST_HOME;
  process.env.PI_C2_TEST_HOME = home;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.PI_C2_TEST_HOME;
    else process.env.PI_C2_TEST_HOME = previous;
  }
}

test("extension startup bootstraps the canonical settings file on first start", () => {
  const home = tempHome();
  try {
    withHome(home, () => {
      assert.equal(existsSync(settingsConfigPath()), false, "fixture starts without a config");
      const pi = {
        registerTool() {},
        registerShortcut() {},
        registerCommand() {},
        on() {},
        setActiveTools() {},
        getAllTools() {
          return [];
        },
        sendUserMessage() {},
      } as unknown as ExtensionAPI;
      piC2Extension(pi);
      assert.equal(existsSync(settingsConfigPath()), true, "first start creates the canonical config");
      const parsed = JSON.parse(readFileSync(settingsConfigPath(), "utf8")) as { commands?: { goalMaxPromptLength?: number } };
      assert.equal(parsed.commands?.goalMaxPromptLength, 4_000);
      // A customized config is never overwritten by a later start.
      writeFileSync(settingsConfigPath(), JSON.stringify({ commands: { goalMaxPromptLength: 9 } }));
      piC2Extension(pi);
      assert.equal(JSON.parse(readFileSync(settingsConfigPath(), "utf8")).commands?.goalMaxPromptLength, 9);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * Phase 4 extension-wiring tests.
 *
 * These codify the phase's acceptance criteria that are verifiable without a
 * live PI host: the composition root registers the `question` tool, the
 * registration stays main-agent-only (nothing is registered for child
 * sessions), and the extension re-exports `QuestionDetails`.
 */
test("pi-c2 extension registers Telegram setup and goal workflow alongside existing tools", () => {
  const names: string[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  const pi = {
    registerTool(tool: { name: string }) {
      names.push(tool.name);
    },
    registerShortcut() {},
    registerCommand(name: string) {
      commands.push(name);
    },
    on(event: string) {
      events.push(event);
    },
    setActiveTools() {},
    getAllTools() {
      return [];
    },
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
  piC2Extension(pi);
  assert.ok(names.includes("question"), "question tool registered");
  assert.ok(names.includes("agent"), "agent tool registered");
  assert.ok(names.includes("agent_status"), "agent_status tool registered");
  assert.ok(names.includes("telegram_chat"), "telegram_chat tool registered");
  assert.ok(names.includes("web_search"), "web_search tool registered");
  assert.ok(names.includes("web_fetch"), "web_fetch tool registered");
  assert.ok(names.includes("knowledge_search"), "knowledge_search tool registered");
  assert.deepEqual(
    names.filter((name) => name.startsWith("goal_")),
    ["goal_create", "goal_pause", "goal_resume", "goal_status", "goal_clear"],
  );
  assert.equal(
    commands.filter((name) => name === "setup-channel-telegram").length,
    1,
    "setup command registered exactly once",
  );
  assert.equal(
    commands.filter((name) => name === "setup-references").length,
    1,
    "references setup command registered exactly once",
  );
  assert.equal(commands.filter((name) => name === "goal").length, 1, "goal command registered exactly once");
  assert.ok(events.includes("session_start"), "session_start lifecycle handler registered");
  assert.ok(events.includes("session_shutdown"), "session_shutdown lifecycle handler registered");
  assert.ok(events.filter((event) => event === "session_start").length >= 2, "MCP lifecycle registers session_start");
  assert.ok(events.includes("session_before_switch"), "goal replacement gate is registered");
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
  piC2Extension(pi);
  // Child sessions receive only the built-in allowlist; the extension never
  // registers anything scoped to child sessions, so the question tool (like the
  // other pi-c2 tools) is structurally main-agent-only.
  assert.deepEqual(names, [
    "mcp_resources_list",
    "mcp_resources_read",
    "question",
    "agent",
    "agent_cancel",
    "agent_status",
    "agent_jobs",
    "agent_list",
    "goal_create",
    "goal_pause",
    "goal_resume",
    "goal_status",
    "goal_clear",
    "web_fetch",
    "web_search",
    "knowledge_search",
    "telegram_chat",
  ]);
});

test("parent startup activates the registered tools including web_search and web_fetch", async () => {
  const registered: string[] = [];
  let activeTools: string[] | undefined;
  const sessionStarts: Array<(event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown> = [];
  const pi = {
    registerTool(tool: { name: string }) {
      registered.push(tool.name);
    },
    registerShortcut() {},
    registerCommand() {},
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown) {
      if (event === "session_start") sessionStarts.push(handler);
    },
    setActiveTools(toolNames: string[]) {
      activeTools = toolNames;
    },
    getAllTools() {
      return registered.map((name) => ({ name }));
    },
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
  piC2Extension(pi);
  assert.ok(sessionStarts.length > 0, "session_start handler registered");
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp",
    ui: { notify() {}, setFooter() {}, onTerminalInput() {
      return () => {};
    } },
    sessionManager: {
      getSessionId: () => "root-session",
      getSessionFile: () => undefined,
    },
  } as unknown as ExtensionContext;
  await Promise.all(sessionStarts.map((handler) => handler?.({ type: "session_start", reason: "startup" }, ctx)));
  assert.ok(activeTools, "setActiveTools called on startup");
  assert.ok(activeTools.includes("web_search"), "web_search active in parent session");
  assert.ok(activeTools.includes("web_fetch"), "web_fetch active in parent session");
  assert.ok(activeTools.includes("knowledge_search"), "knowledge_search active in parent session");
  assert.equal(activeTools.includes("mcp_resources_list"), false, "empty MCP surface hides resource listing");
  assert.equal(activeTools.includes("mcp_resources_read"), false, "empty MCP surface hides resource reads");
  assert.equal(activeTools.includes("ls"), false, "ls stays excluded");
});

test("research tool descriptions direct local-first lookup and automatic fallback saving", () => {
  const descriptions = new Map<string, string>();
  const pi = {
    registerTool(tool: { name: string; description: string }) {
      descriptions.set(tool.name, tool.description);
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
  piC2Extension(pi);
  const wiki = descriptions.get("knowledge_search") ?? "";
  const search = descriptions.get("web_search") ?? "";
  const fetch = descriptions.get("web_fetch") ?? "";
  assert.match(wiki, /local/i);
  assert.match(wiki, /web_search/);
  assert.match(wiki, /web_fetch/);
  assert.match(search, /local.*wiki/i);
  assert.match(search, /fall\s*back/i);
  assert.match(search, /automatically saved/i);
  assert.match(search, /broad discovery/i);
  assert.match(search, /candidate URLs/i);
  assert.match(fetch, /local.*wiki/i);
  assert.match(fetch, /web_search/i);
  assert.match(fetch, /automatically saved/i);
  assert.match(fetch, /narrow/i);
  assert.match(fetch, /candidate URL/i);
  assert.match(fetch, /search response/i);
});

test("extension re-exports the web and wiki search details types", () => {
  const searchDetails: WebSearchDetails = { query: "typescript", provider: "exa" };
  const fetchDetails: WebFetchDetails = {};
  const wikiDetails: KnowledgeSearchDetails = { mode: "wikis", query: "typescript", results: [] };
  assert.equal(searchDetails.provider, "exa");
  assert.deepEqual(fetchDetails, {});
  assert.deepEqual(wikiDetails.results, []);
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
  assert.equal(extensionName, "pi-c2");
  assert.equal(details.options.length, 2);
});
