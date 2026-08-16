import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { registerAgentTool } from "../src/registrations/agent.ts";
import { registerCancelTool } from "../src/registrations/cancel.ts";
import { registerAgentListTool } from "../src/registrations/agent-list.ts";
import { registerJobsTool } from "../src/registrations/jobs.ts";
import { registerStatusTool } from "../src/registrations/status.ts";
import { registerGoalTools } from "../src/registrations/goals.ts";
import { registerKnowledgeSearchTool } from "../src/registrations/knowledge-search.ts";
import { registerQuestionTool } from "../src/registrations/question.ts";
import { registerTelegramChatTool } from "../src/registrations/telegram.ts";
import { registerWebFetchTool } from "../src/registrations/web-fetch.ts";
import { registerWebSearchTool } from "../src/registrations/web-search.ts";

const identity = (text: string): string => text;
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: identity,
  italic: identity,
  underline: identity,
  inverse: identity,
  strikethrough: identity,
} as unknown as Theme;

type Tool = {
  name: string;
  renderCall?: (args: unknown, theme: Theme, context: unknown) => { render(width: number): string[] };
  renderResult?: (result: unknown, options: unknown, theme: Theme, context: unknown) => { render(width: number): string[] };
};

function capture(register: (pi: ExtensionAPI) => void): Tool {
  let tool: Tool | undefined;
  register({
    registerTool(candidate: unknown) {
      tool = candidate as Tool;
    },
  } as unknown as ExtensionAPI);
  assert.ok(tool?.renderCall && tool.renderResult, "tool renderers present");
  return tool;
}

const renderContext = { isError: false };
const renderOptions = { expanded: false, isPartial: false };

function text(component: { render(width: number): string[] }): string {
  return stripVTControlCharacters(component.render(120).join("\n"));
}

test("tool renderers expose safe, tool-specific activity without model payloads", () => {
  const goals: Tool[] = [];
  registerGoalTools({ registerTool: (tool: unknown) => { goals.push(tool as Tool); } } as unknown as ExtensionAPI);
  const tools = [
    capture(registerAgentTool),
    capture(registerCancelTool),
    capture(registerAgentListTool),
    capture(registerJobsTool),
    capture(registerStatusTool),
    ...goals,
    capture(registerKnowledgeSearchTool),
    capture(registerQuestionTool),
    capture(registerWebFetchTool),
    capture(registerWebSearchTool),
  ];
  const argsByTool: Record<string, unknown> = {
    agent: { description: "implement feature", prompt: "SECRET_PROMPT", subagent_type: "worker" },
    agent_cancel: { job_id: "job-123" },
    agent_status: { job_id: "job-123" },
    knowledge_search: { type: "wikis", query: "render migration" },
    web_fetch: { url: "https://user:password@example.com/docs?token=secret" },
    web_search: { query: "pi tool rendering" },
  };

  for (const tool of tools) {
    const call = text(tool.renderCall!(argsByTool[tool.name] ?? {}, theme, renderContext));
    const result = text(tool.renderResult!({ content: [{ type: "text", text: "secret internal output" }], details: { prompt: "secret" } }, renderOptions, theme, renderContext));
    assert.ok(call.length > 0, `${tool.name} renders activity`);
    assert.ok(result.length > 0, `${tool.name} renders an outcome`);
    assert.doesNotMatch(call, /secret|internal output/);
    assert.doesNotMatch(result, /secret|internal output/);
  }

  assert.match(text(tools[0]!.renderCall!(argsByTool.agent, theme, renderContext)), /worker/);
  assert.match(text(tools.find((tool) => tool.name === "agent_cancel")!.renderCall!(argsByTool.agent_cancel, theme, renderContext)), /job-123/);
  assert.match(text(tools.find((tool) => tool.name === "agent_status")!.renderCall!(argsByTool.agent_status, theme, renderContext)), /job-123/);
  const knowledge = tools.find((tool) => tool.name === "knowledge_search")!;
  assert.match(text(knowledge.renderCall!(argsByTool.knowledge_search, theme, renderContext)), /render migration/);
  assert.doesNotMatch(text(tools[0]!.renderCall!(argsByTool.agent, theme, renderContext)), /SECRET_PROMPT/);
  assert.doesNotMatch(text(tools.find((tool) => tool.name === "web_fetch")!.renderCall!(argsByTool.web_fetch, theme, renderContext)), /password|token=secret/);
});

test("telegram renderer hides message text and destination details", () => {
  const tool = capture((pi) => registerTelegramChatTool(pi, { registry: { register() {} } as never }));
  const call = text(tool.renderCall!({ action: "send_text", chat_id: "123456", text: "private report" }, theme, renderContext));
  const result = text(tool.renderResult!({ content: [], details: { sent: true, chatId: "123456", action: "send_text" } }, renderOptions, theme, renderContext));
  assert.match(call, /telegram_chat/);
  assert.doesNotMatch(call, /private report|123456/);
  assert.doesNotMatch(result, /123456/);
});
