import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCachedAgentDiscovery } from "@xzy-ai/runtime";
import { TOOL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { agentNoArgsParams } from "../tools.ts";
import type { AgentListDetails } from "../types.ts";
import { textResult } from "../results.ts";
import { renderToolCall, renderToolResult, toolResultFailed } from "../render.ts";

/**
 * Keep the displayed description to its first paragraph so each section stays
 * concise; the full text remains available in the structured `details`.
 */
function firstParagraph(value: string): string {
  return value.split(/\r?\n\s*\n/)[0] ?? value;
}

/** Prefix every description line so multiline agent metadata remains readable. */
function indentBlock(value: string): string {
  return firstParagraph(value)
    .split(/\r?\n/)
    .map((line) => `   ${line}`)
    .join("\n");
}

/** Register the `agent_list` tool for inspecting available agent definitions. */
export function registerAgentListTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "agent_list",
    label: "List agents",
    description: "List available agent definitions with name and description.",
    parameters: agentNoArgsParams,
    async execute(
      _toolCallId: string,
      _params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<AgentListDetails>> {
      return processWithLog({ operation: TOOL_OPERATIONS.AGENT_LIST_EXECUTE }, async () => {
      const agents = createCachedAgentDiscovery(ctx.cwd)
        .all()
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(({ name, description }) => ({ name, description }));
      if (agents.length === 0) {
        return textResult("No agent definitions are currently available.", { agents });
      }
      const sections = agents.map(
        (agent, index) =>
          `${index + 1}. ${agent.name}\n${indentBlock(agent.description)}`,
      );
      return textResult(`Available agents:\n${sections.join("\n")}`, { agents });
      });
    },
    renderCall(_args, theme) {
      return renderToolCall(theme, "agent_list", "listing available agents");
    },
    renderResult(_result, options, theme, context) {
      return renderToolResult(theme, "agent list ready", toolResultFailed(_result, context), options.isPartial);
    },
  });
}
