import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createReferenceCatalog, type ReferenceCatalogReadResult } from "@xzy-ai/runtime";
import { errorResult, textResult } from "../results.ts";
import { discoverWikiTopics, retrieveWikiPage, searchWikis, wikiRoot } from "../wiki.ts";

const llmWikisSearchParams = Type.Object({
  type: Type.Union(
    [
      Type.Literal("wikis", { description: "Search the local LLM wiki corpus with ranking, wildcard discovery, or page retrieval" }),
      Type.Literal("references", { description: "Discover and select configured reference aliases as readable roots" }),
    ],
    { description: "Which local research surface to use" },
  ),
  query: Type.Optional(Type.String({ description: "Search query for local wikis, or \"*\" to discover available topics/pages or reference aliases. Not required for wiki page retrieval." })),
  topic: Type.Optional(Type.String({ description: "Optional wiki topic filter" })),
  page: Type.Optional(Type.String({ description: "Optional wiki page selector" })),
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum local wiki excerpts to return" })),
  alias: Type.Optional(Type.String({ description: "Configured reference alias to select, when type is references" })),
});

export type LlmWikisSearchType = "wikis" | "references";

type LlmWikisSearchParams = {
  type: LlmWikisSearchType;
  query?: string;
  topic?: string;
  page?: string;
  maxResults?: number;
  alias?: string;
};

export interface LlmWikisSearchResultItem {
  file: string;
  topic: string;
  page: number;
  totalPages: number;
  timestamp?: string;
  source: string;
  score: number;
  excerpt: string;
}

/** Model-safe view over the runtime references catalog for discovery and selection. */
export interface ReferenceCatalogReader {
  read: () => Promise<ReferenceCatalogReadResult>;
}

export type LlmWikisSearchDetails =
  | {
      mode: "wikis";
      query?: string;
      topic?: string;
      results: LlmWikisSearchResultItem[];
      page?: {
        file: string;
        topic: string;
        page: number;
        totalPages: number;
        previous?: string;
        next?: string;
      };
      discovery?: {
        topics: Array<{
          topic: string;
          pages: Array<{
            file: string;
            page: number;
            totalPages: number;
            previous?: string;
            next?: string;
          }>;
        }>;
      };
    }
  | {
      mode: "references";
      query?: string;
      aliases: Array<{
        alias: string;
        type: "local" | "git";
        description?: string;
        status: string;
        diagnostic?: string;
      }>;
      diagnostics?: string[];
    }
  | {
      mode: "error";
      message: string;
    };

export interface LlmWikisSearchExecutionOptions {
  wikiRoot?: string;
  referenceCatalog?: ReferenceCatalogReader;
  signal?: AbortSignal;
}

/** Register the local-first LLM wiki and reference research tool. */
export function registerLlmWikisSearchTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "llm_wikis_search",
    label: "LLM wiki search",
    description:
      "Search the local LLM wiki cache or configured references for reusable research. Use type=\"wikis\" to search the local wiki cache with a broad-to-specific workflow: first run a broad query without topic/page (for example, query=\"pi\") to discover available topics and page identifiers; use query=\"*\" to list available wiki topics and pages; then use the returned topic and page values with a narrower query or direct topic/page lookup to retrieve targeted evidence. Use type=\"references\" to work with configured reference aliases: use query=\"*\" to list discoverable aliases (descriptions and source kinds included), then call again with the chosen alias to select its readable root; after a root is selected, inspect the referenced content with normal filesystem tools such as read, grep, and find rather than searching it here. This tool searches the local cache only; when information is absent, insufficient, or time-sensitive, use web_search for discovery and web_fetch for primary-source details. Successful web results are saved automatically for future wiki searches. Treat cached content as potentially stale and verify version-sensitive claims against current web sources.",
    parameters: llmWikisSearchParams,
    async execute(
      _toolCallId: string,
      params: LlmWikisSearchParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<LlmWikisSearchDetails>> {
      return executeLlmWikisSearch(params, { signal });
    },
  });
}

function signalAborted(options?: LlmWikisSearchExecutionOptions): boolean {
  return Boolean(options?.signal?.aborted);
}

export async function executeLlmWikisSearch(
  params: LlmWikisSearchParams,
  options?: LlmWikisSearchExecutionOptions,
): Promise<AgentToolResult<LlmWikisSearchDetails>> {
  if (params.type !== "wikis" && params.type !== "references") {
    return errorResult("Unsupported llm_wikis_search type.", { mode: "error", message: "Unsupported llm_wikis_search type." });
  }
  if (params.type === "references") {
    if (signalAborted(options)) {
      return errorResult("Reference research aborted.", { mode: "error", message: "Reference research aborted." });
    }
    const reader = options?.referenceCatalog ?? createReferenceCatalog();
    let read: ReferenceCatalogReadResult;
    try {
      read = await reader.read();
    } catch {
      return textResult("No configured references are available right now.", {
        mode: "references",
        ...(params.query === undefined ? {} : { query: params.query }),
        aliases: [],
        diagnostics: ["Reference discovery is temporarily unavailable"],
      });
    }
    const aliases = read.entries
      .filter((entry) => !entry.hidden)
      .map((entry) => ({
        alias: entry.name,
        type: entry.source.type,
        ...(entry.description ? { description: entry.description } : {}),
        status: entry.status,
        ...(entry.status === "unavailable" && entry.diagnostic ? { diagnostic: entry.diagnostic } : {}),
      }))
      .sort((left, right) => left.alias.localeCompare(right.alias));
    const diagnostics = read.diagnostics.filter((message) => typeof message === "string");
    if (aliases.length === 0) {
      return textResult("No configured references found.", {
        mode: "references",
        ...(params.query === undefined ? {} : { query: params.query }),
        aliases: [],
        diagnostics,
      });
    }
    const rendered = aliases
      .map((alias) =>
        [
          `- ${alias.alias} (${alias.type}) ${alias.description ?? ""}`.trimEnd(),
          alias.status === "unavailable" ? `  status: unavailable${alias.diagnostic ? ` (${alias.diagnostic})` : ""}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n");
    return textResult(rendered, {
      mode: "references",
      ...(params.query === undefined ? {} : { query: params.query }),
      aliases,
      diagnostics,
    });
  }
  const root = options?.wikiRoot ?? wikiRoot();
  if (params.topic !== undefined && params.page !== undefined) {
    const page = await retrieveWikiPage(root, params.topic, params.page);
    if (!page) {
      return textResult("No local wiki matches found.", {
        mode: "wikis",
        ...(params.query === undefined ? {} : { query: params.query }),
        topic: params.topic,
        results: [],
      });
    }
    return textResult(page.content, {
      mode: "wikis",
      ...(params.query === undefined ? {} : { query: params.query }),
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
  const query = params.query ?? "";
  if (query === "*") {
    const topics = await discoverWikiTopics(root, {
      topic: params.topic,
      maxTopics: params.maxResults,
    });
    if (topics.length === 0) {
      return textResult("No local wiki pages found.", {
        mode: "wikis",
        query,
        ...(params.topic === undefined ? {} : { topic: params.topic }),
        results: [],
        discovery: { topics: [] },
      });
    }
    const rendered = topics
      .map((topic) => [`Topic: ${topic.topic}`, ...topic.pages.map((page) => `  - ${page.file}`)].join("\n"))
      .join("\n");
    return textResult(rendered, {
      mode: "wikis",
      query,
      ...(params.topic === undefined ? {} : { topic: params.topic }),
      results: [],
      discovery: { topics },
    });
  }
  const results = await searchWikis(root, query, {
    topic: params.topic,
    max: params.maxResults,
  });
  if (results.length === 0) {
    return textResult("No local wiki matches found.", {
      mode: "wikis",
      ...(params.query === undefined ? {} : { query: params.query }),
      ...(params.topic === undefined ? {} : { topic: params.topic }),
      results: [],
    });
  }
  const rendered = results
    .map((item) => `- [${item.file}] (${item.score}) ${item.excerpt}`)
    .join("\n");
  return textResult(rendered, {
    mode: "wikis",
    ...(params.query === undefined ? {} : { query: params.query }),
    ...(params.topic === undefined ? {} : { topic: params.topic }),
    results,
  });
}

export { llmWikisSearchParams };
