import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { textResult } from "../results.ts";
import { retrieveWikiPage, searchWikis, wikiRoot } from "../wiki.ts";

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
  page?: {
    file: string;
    topic: string;
    page: number;
    totalPages: number;
    previous?: string;
    next?: string;
  };
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
      "Search the local LLM wiki cache for reusable research. Use a broad-to-specific workflow: first run a broad query without topic/page (for example, query=\"pi\") to discover available topics and page identifiers; then use the returned topic and page values with a narrower query or direct page lookup to retrieve targeted evidence. Use topic to scope results and page to retrieve a specific page; when both are supplied, the page is retrieved directly. If a search is empty, retry with a broader query, relaxed filters, or synonyms. This tool searches the local cache only; when information is absent, insufficient, or time-sensitive, use web_search for discovery and web_fetch for primary-source details. Successful web results are saved automatically for future wiki searches. Treat cached content as potentially stale and verify version-sensitive claims against current web sources.",
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
  const root = options?.wikiRoot ?? wikiRoot();
  if (params.topic !== undefined && params.page !== undefined) {
    const page = await retrieveWikiPage(root, params.topic, params.page);
    if (!page) {
      return textResult("No local wiki matches found.", {
        query: params.query,
        topic: params.topic,
        results: [],
      });
    }
    return textResult(page.content, {
      query: params.query,
      topic: params.topic,
      results: [],
      page: {
        file: page.file,
        topic: page.topic,
        page: page.page,
        totalPages: page.totalPages,
        ...(page.previous ? { previous: page.previous } : {}),
        ...(page.next ? { next: page.next } : {}),
      },
    });
  }
  const results = await searchWikis(root, params.query, {
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
