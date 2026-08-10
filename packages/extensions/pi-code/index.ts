import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerAgentTool,
  registerCancelTool,
  registerQuestionTool,
  registerStatusTool,
  registerJobsTool,
  registerGoalTools,
  registerAgentFooter,
  registerTelegramChatTool,
} from "@xzy-ai/tools";
import {
  registerSessionEvents,
  registerLifecycleGates,
  registerTelegramSetup,
  registerTelegramLifecycle,
  registerTelegramInbound,
  registerGoalCommand,
} from "@xzy-ai/commands";
import { MAX_CONCURRENCY, MAX_PARALLEL_AGENTS } from "@xzy-ai/core";
import type {
  AgentDetails,
  AgentErrorDetails,
  CancelDetails,
  JobSummary,
  JobsDetails,
  QuestionDetails,
  StatusDetails,
} from "@xzy-ai/tools";

const extensionName = "pi-code";

/** PI extension entry point. */
export default function piCodeExtension(pi: ExtensionAPI): void {
  registerTelegramSetup(pi);
  // Inbound registration precedes the connection lifecycle so its message
  // middleware is attached before the shared manager starts polling.
  registerTelegramInbound(pi);
  registerTelegramLifecycle(pi);
  registerQuestionTool(pi);
  registerAgentTool(pi);
  registerCancelTool(pi);
  registerStatusTool(pi);
  registerJobsTool(pi);
  registerGoalTools(pi);
  registerAgentFooter(pi);
  registerTelegramChatTool(pi);
  registerSessionEvents(pi);
  registerLifecycleGates(pi);
  registerGoalCommand(pi);
}

export { extensionName };
export { MAX_CONCURRENCY, MAX_PARALLEL_AGENTS };
export type {
  AgentDetails,
  AgentErrorDetails,
  CancelDetails,
  JobSummary,
  JobsDetails,
  QuestionDetails,
  StatusDetails,
};