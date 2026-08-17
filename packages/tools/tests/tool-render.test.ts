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
  assert.ok(tool?.renderResult, "tool renderer present");
  return tool;
}

const renderContext = { isError: false };
const collapsedOptions = { expanded: false, isPartial: false };
const expandedOptions = { expanded: true, isPartial: false };

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
    const args = argsByTool[tool.name] ?? {};
    const call = tool.renderCall ? text(tool.renderCall(args, theme, renderContext)) : "";
    const result = text(tool.renderResult!({ content: [{ type: "text", text: "secret internal output" }], details: { prompt: "secret" } }, collapsedOptions, theme, renderContext));
    if (tool.renderCall) {
      assert.ok(call.length > 0, `${tool.name} renders activity`);
      assert.doesNotMatch(call, /secret|internal output/);
      const expandedCall = text(tool.renderCall(args, theme, { ...renderContext, expanded: true, args }));
      assert.match(expandedCall, /Arguments:/, `${tool.name} exposes expanded arguments`);
    }
    assert.ok(result.length > 0, `${tool.name} renders an outcome`);
    assert.doesNotMatch(result, /secret|internal output/);
    const expandedResult = text(tool.renderResult!({ content: [{ type: "text", text: "traceable internal output" }], details: { prompt: "traceable" } }, expandedOptions, theme, { ...renderContext, expanded: true, args }));
    if (tool.name === "agent_cancel" || tool.name === "agent_status") {
      assert.match(expandedResult, /\"prompt\"|traceable internal output|not cancellable|unknown/);
    } else {
      assert.match(expandedResult, /traceable internal output|\"prompt\"/, `${tool.name} exposes expanded result tracing`);
    }
  }


});

test("expanded regular-tool failures stay concise and safe", () => {
  const telegram = capture((pi) => registerTelegramChatTool(pi, { registry: { register() {} } as never }));
  const failed = text(telegram.renderResult!({
    content: [{ type: "text", text: "Error: transport response secret" }],
    details: { isError: true, access_token: "tok-secret", requestId: "req-secret" },
  }, expandedOptions, theme, { isError: true, expanded: true }));
  assert.match(failed, /failed|✗/);
  assert.doesNotMatch(failed, /transport response secret|tok-secret|req-secret/);
  assert.doesNotMatch(failed, /Arguments:|Result:/);
});

test("expanded argument and result traces redact token and transport key variants", () => {
  const webSearch = capture(registerWebSearchTool);
  const args = { access_token: "tok-secret", refreshToken: "refresh-secret", requestId: "req-secret", clientId: "client-id", client_id: "client-id-2", authorization: "Bearer abc.def" };
  const call = text(webSearch.renderCall!(args, theme, { expanded: true, args }));
  assert.doesNotMatch(call, /tok-secret|refresh-secret|req-secret|client-id|abc\.def/);
  const result = text(webSearch.renderResult!({ content: [{ type: "text", text: "safe result access_token=tok-secret requestId=req-secret traceId=trace-secret client_secret=client-secret client_id=client-id api_secret=api-secret https://example.test/?client_secret=url-secret&client_id=url-id" }], details: args }, expandedOptions, theme, { expanded: true, args }));
  assert.match(result, /safe result/);
  assert.doesNotMatch(result, /tok-secret|refresh-secret|req-secret|trace-secret|abc\.def|client-secret|client-id|api-secret|url-secret|url-id/);
});

test("renderers follow the agreed expanded tool contracts", () => {
  const goals: Tool[] = [];
  registerGoalTools({ registerTool: (tool: unknown) => { goals.push(tool as Tool); } } as unknown as ExtensionAPI);
  const agent = capture(registerAgentTool);
  const agentResult = {
    content: [{ type: "text", text: "Agent completed" }],
    details: { jobId: "job-123", status: "completed", subagentType: "explore", description: "audit renderers", prompt: "inspect every renderer" },
  };
  const agentArgs = { description: "audit renderers", prompt: "inspect every renderer", subagent_type: "explore", background: true };
  const agentExpandedCall = text(agent.renderCall!(agentArgs, theme, { ...renderContext, expanded: true, args: agentArgs }));
  assert.match(agentExpandedCall, /\"prompt\"/);
  assert.match(agentExpandedCall, /inspect every renderer/);
  const agentExpanded = text(agent.renderResult!(agentResult, expandedOptions, theme, { ...renderContext, expanded: true, args: agentArgs }));
  assert.match(agentExpanded, /completed/);
  assert.match(agentExpanded, /inspect every renderer/);
  assert.match(agentExpanded, /Agent completed/);
  assert.doesNotMatch(agentExpanded.slice(agentExpanded.indexOf("Result:")), /\"jobId\"|\"subagentType\"|\"prompt\"/);

  const jobs = capture(registerJobsTool);
  const jobsResult = { content: [{ type: "text", text: "Subagent jobs:\n- job-123: running (audit renderers)" }], details: { jobs: [{ jobId: "job-123", status: "running", subagentType: "explore", description: "audit renderers" }] } };
  assert.match(text(jobs.renderResult!(jobsResult, collapsedOptions, theme, renderContext)), /1 jobs/);
  assert.match(text(jobs.renderResult!(jobsResult, expandedOptions, theme, renderContext)), /audit renderers/);
  assert.doesNotMatch(text(jobs.renderResult!(jobsResult, expandedOptions, theme, renderContext)), /\"jobs\"|\"subagentType\"/);

  const goalCreate = goals.find((tool) => tool.name === "goal_create")!;
  const goalResult = { content: [{ type: "text", text: "Goal created successfully! Please proceed carefully and complete the work correctly.\nGoal status: active\nPrompt: finish the migration\nInterval: 60000ms" }], details: { goal: { prompt: "finish the migration", intervalMs: 60_000, status: "active" } } };
  assert.match(text(goalCreate.renderResult!(goalResult, collapsedOptions, theme, renderContext)), /Goal created/);
  assert.match(text(goalCreate.renderResult!(goalResult, expandedOptions, theme, renderContext)), /finish the migration/);
  assert.doesNotMatch(text(goalCreate.renderResult!(goalResult, expandedOptions, theme, renderContext)), /\"goal\"|goalId|updatedAt/);

  const webSearch = capture(registerWebSearchTool);
  const webArgs = { query: "pi renderers", numResults: 3, type: "deep" };
  assert.match(text(webSearch.renderCall!(webArgs, theme, { ...renderContext, expanded: true, args: webArgs })), /\"numResults\"/);
  const webResult = { content: [{ type: "text", text: "Result one\nResult body" }], details: { query: "pi renderers", provider: "exa", results: [{ title: "Result one", url: "https://example.com" }] } };
  assert.match(text(webSearch.renderResult!(webResult, collapsedOptions, theme, renderContext)), /results/);
  const webExpanded = text(webSearch.renderResult!(webResult, expandedOptions, theme, { ...renderContext, expanded: true, args: webArgs }));
  assert.match(webExpanded, /Result body/);
  assert.match(webExpanded, /Result one/);
  assert.doesNotMatch(webExpanded, /\"provider\"|\"wiki\"|wikiSaveError/);

  const telegram = capture((pi) => registerTelegramChatTool(pi, { registry: { register() {} } as never }));
  const telegramResult = { content: [], details: { sent: true, action: "send_text", message: "private report", chatId: "123456", messageId: 456 } };
  assert.doesNotMatch(text(telegram.renderResult!(telegramResult, collapsedOptions, theme, renderContext)), /private report|123456/);
  const telegramExpanded = text(telegram.renderResult!(telegramResult, expandedOptions, theme, renderContext));
  assert.match(telegramExpanded, /private report/);
  assert.doesNotMatch(telegramExpanded, /messageId|chatId/);
});
