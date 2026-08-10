import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { textResult } from "../results.ts";
import { searchWikis, wikiRoot } from "../wiki.ts";

const llmWikisSearchParams = Type.Object({
  query: Type.String({ description: "Search local LLM wikis before falling back to web research" }),
  topic: Type.Optional(Type.String({ description: "Optional wiki topic filter" })),
  page: Type.Optional(Type.String({ description: "Optional wiki page selector" })),
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum local wiki excerpts to return" })),
});

type LlmWikisSearchParams = {
  query: string;
  topic?: string;
  page?: string;
  maxResults?: number;
};

export interface LlmWikisSearchDetails {
  query: string;
  topic?: string;
  results: Array<{
    file: string;
    topic: string;
    page: number;
    totalPages: number;
    timestamp?: string;
    source: string;
    score: number;
    excerpt: string;
  }>;
}

export interface LlmWikisSearchExecutionOptions {
  wikiRoot?: string;
}

/** Register the local-first LLM wiki search tool. */
export function registerLlmWikisSearchTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "llm_wikis_search",
    label: "LLM wiki search",
    description:
      "Search local LLM wikis first for reusable research. If local information is absent or insufficient, fall back to web_search or web_fetch; successful web results are saved automatically for future use.",
    parameters: llmWikisSearchParams,
    async execute(
      _toolCallId: string,
      params: LlmWikisSearchParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<LlmWikisSearchDetails>> {
      return executeLlmWikisSearch(params);
    },
  });
}

export async function executeLlmWikisSearch(
  params: LlmWikisSearchParams,
  options?: LlmWikisSearchExecutionOptions,
): Promise<AgentToolResult<LlmWikisSearchDetails>> {
  // Phase 2 establishes the callable contract and empty-storage behavior.
  // Reading, ranking, and page traversal are added in Phase 3/5.
  void (options?.wikiRoot ?? wikiRoot());
  const results = await searchWikis(options?.wikiRoot ?? wikiRoot(), params.query, {
    topic: params.topic,
    max: params.maxResults,
  });
  if (results.length === 0) {
    return textResult("No local wiki matches found.", {
      query: params.query,
      ...(params.topic === undefined ? {} : { topic: params.topic }),
      results: [],
    });
  }
  const rendered = results
    .map((item) => `- [${item.file}] (${item.score}) ${item.excerpt}`)
    .join("\n");
  return textResult(rendered, {
    query: params.query,
    ...(params.topic === undefined ? {} : { topic: params.topic }),
    results,
  });
}

export { llmWikisSearchParams };
