import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerAgentTool,
  registerCancelTool,
  registerQuestionTool,
  registerStatusTool,
  registerJobsTool,
  registerAgentFooter,
  registerTelegramChatTool,
} from "@xzy-ai/tools";
import {
  registerSessionEvents,
  registerLifecycleGates,
  registerConnectionMarker,
  registerSetupChannelCommand,
  registerTelegramInbound,
  registerTelegramFinalForwarding,
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
  registerQuestionTool(pi);
  registerAgentTool(pi);
  registerCancelTool(pi);
  registerStatusTool(pi);
  registerJobsTool(pi);
  registerTelegramChatTool(pi);
  registerAgentFooter(pi);
  registerSessionEvents(pi);
  registerLifecycleGates(pi);
  registerConnectionMarker(pi);
  registerSetupChannelCommand(pi);
  registerTelegramInbound(pi);
  registerTelegramFinalForwarding(pi);
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