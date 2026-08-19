import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerAgentTool,
  registerCancelTool,
  registerQuestionTool,
  registerWriteMarkdownTool,
  registerEditMarkdownTool,
  registerWriteEditTicketTool,
  createPonytailWriteTool,
  createPonytailEditTool,
  createDeepThinkTool,
  registerStatusTool,
  registerJobsTool,
  registerAgentListTool,
  registerGoalTools,
  registerWebFetchTool,
  registerWebSearchTool,
  registerKnowledgeSearchTool,
  registerAgentFooter,
  registerTelegramChatTool,
} from "@xzy-ai/tools";
import {
  registerSessionEvents,
  registerSystemPrompt,
  registerLifecycleGates,
  registerPonytailSetup,
  registerThinkingSetup,
  registerTelegramSetup,
  registerReferencesSetup,
  registerManageAgentModel,
  registerManageCompactThreshold,
  registerCompactionLogging,
  registerTelegramClear,
  registerTelegramLifecycle,
  registerTelegramInbound,
  registerGoalCommand,
  registerManageGoal,
  registerNotifyEntry,
  registerContextAutoCompact,
  createDefaultTelegramCommandExpander,
} from "@xzy-ai/commands";
import { MAX_CONCURRENCY, MAX_PARALLEL_AGENTS } from "@xzy-ai/core";
import { registerChildExtensionFactory, registerChildPonytailTools, registerChildThinkingTool } from "@xzy-ai/runtime";
import { bootstrapSettingsConfig, migrateLegacyGoalLimit } from "@xzy-ai/runtime";
import { registerMcpLifecycle } from "@xzy-ai/mcp";
import type {
  AgentDetails,
  AgentErrorDetails,
  AgentListDetails,
  CancelDetails,
  JobSummary,
  JobsDetails,
  QuestionDetails,
  StatusDetails,
  WebFetchDetails,
  WebSearchDetails,
  KnowledgeSearchDetails,
} from "@xzy-ai/tools";

const extensionName = "pi-c2";

/** PI extension entry point. */
export default function piC2Extension(pi: ExtensionAPI): void {
  // First run after installation auto-materials the canonical settings file so
  // all keys and defaults are immediately present and user-editable. It is
  // idempotent and never overwrites an existing user-owned or malformed file;
  // a failure is non-fatal and startup continues on resolver defaults.
  bootstrapSettingsConfig();
  // One-time best-effort migration: existing installs bootstrapped with the
  // legacy 4 000 goal limit get bumped to the new 10 000 default without
  // manual file editing. New installs are unaffected (bootstrap already
  // writes 10 000).
  migrateLegacyGoalLimit();

  // Child sessions create an isolated SDK resource loader. Register this same
  // inline factory process-wide before composing tools so those loaders can
  // construct the agent-family/web registrations; their child allowlists still
  // exclude goal and MCP root-only tools. The Ponytail write/edit wrapper
  // definitions are published the same way: children inject them through their
  // custom-tools list only when the child's effective Ponytail state is
  // enabled.
  registerChildExtensionFactory(piC2Extension);
  registerChildPonytailTools({
    write: createPonytailWriteTool(),
    edit: createPonytailEditTool(),
  });
  registerChildThinkingTool({ deepThink: createDeepThinkTool() });

  // The Telegram bridge dispatches extension commands with explicit expanders
  // (goal) plus prompt/skill files discovered from the Pi command catalog, and
  // publishes the same catalog as the Telegram bot menu on every start.
  const getCommands = () => pi.getCommands();
  const expander = createDefaultTelegramCommandExpander(getCommands);

  const getMenuCommands = () => expander.menuSources();
  registerTelegramSetup(pi, { getCommands: getMenuCommands });
  registerReferencesSetup(pi);
  registerManageAgentModel(pi);
  registerManageCompactThreshold(pi);
  registerCompactionLogging(pi);
  registerTelegramClear(pi);
  // Inbound registration precedes the connection lifecycle so its message
  // middleware is attached before the shared manager starts polling.
  registerTelegramInbound(pi, {
    expandCommand: (name, args) => expander.expand(name, args),
  });
  registerTelegramLifecycle(pi, { getCommands: getMenuCommands });
  registerMcpLifecycle(pi);
  registerQuestionTool(pi);
  registerWriteMarkdownTool(pi);
  registerEditMarkdownTool(pi);
  registerWriteEditTicketTool(pi);
  registerAgentTool(pi);
  registerCancelTool(pi);
  registerStatusTool(pi);
  registerJobsTool(pi);
  registerAgentListTool(pi);
  registerGoalTools(pi);
  registerWebFetchTool(pi);
  registerWebSearchTool(pi);
  registerKnowledgeSearchTool(pi);
  registerAgentFooter(pi);
  registerTelegramChatTool(pi);
  registerSessionEvents(pi, {
    ponytailWriteEditTools: () => ({
      write: createPonytailWriteTool(),
      edit: createPonytailEditTool(),
    }),
    thinkingTool: () => createDeepThinkTool(),
  });
  registerContextAutoCompact(pi);
  registerPonytailSetup(pi);
  registerThinkingSetup(pi);
  registerSystemPrompt(pi);
  registerLifecycleGates(pi);
  registerGoalCommand(pi);
  registerManageGoal(pi);
  registerNotifyEntry(pi);
}

export { extensionName };
export { MAX_CONCURRENCY, MAX_PARALLEL_AGENTS };
export type {
  AgentDetails,
  AgentErrorDetails,
  AgentListDetails,
  CancelDetails,
  JobSummary,
  JobsDetails,
  QuestionDetails,
  StatusDetails,
  WebFetchDetails,
  WebSearchDetails,
  KnowledgeSearchDetails,
};
