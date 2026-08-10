import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAgentDiscovery } from "@xzy-ai/runtime";
import { agentNoArgsParams } from "../tools.ts";
import type { AgentListDetails } from "../types.ts";
import { textResult } from "../results.ts";

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
      const agents = createAgentDiscovery(ctx.cwd)
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
    },
  });
}
