import { readdir } from "node:fs/promises";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TOOL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { createReferenceCatalog, getChildPool, type ReferenceCatalogReadResult } from "@xzy-ai/runtime";
import { errorResult, textResult } from "../results.ts";
import {
  discoverWikiTopics,
  MAX_WIKI_DISCOVERY_OUTPUT_BYTES,
  retrieveWikiPage,
  searchWikis,
  wikiRoot,
} from "../wiki.ts";

const commonQuery = Type.Optional(Type.String({ description: "Search query, or \"*\" for deterministic discovery. Not required for page/root selection." }));
const discoveryQuery = Type.Optional(Type.String({ description: "Grouped discovery/search query; omitted or \"*\" discovers both configured references and wiki topics." }));
const maxResults = Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum results or topics to return" }));
const knowledgeSearchParams = Type.Union([
  Type.Object({
    type: Type.Literal("wikis", { description: "Search, discover, or retrieve pages from the local wiki corpus" }),
    query: commonQuery,
    topic: Type.Optional(Type.String({ description: "Optional wiki topic filter" })),
    page: Type.Optional(Type.String({ description: "Optional wiki page selector" })),
    maxResults,
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("references", { description: "Discover configured reference aliases or select a readable root" }),
    query: commonQuery,
    alias: Type.Optional(Type.String({ description: "Configured reference alias to select a readable root; omit it with query=\"*\" to discover non-hidden aliases" })),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Optional(Type.Null()),
    query: discoveryQuery,
  }, { additionalProperties: false }),
]);

export type KnowledgeSearchType = "wikis" | "references";

type KnowledgeSearchParams =
  | {
      type: "wikis";
      query?: string;
      topic?: string;
      page?: string;
      maxResults?: number;
      alias?: never;
    }
  | {
      type: "references";
      query?: string;
      alias?: string;
      topic?: never;
      page?: never;
      maxResults?: never;
    }
  | {
      type?: null;
      query?: string;
      alias?: never;
      topic?: never;
      page?: never;
      maxResults?: never;
    };

export interface KnowledgeSearchResultItem {
  file: string;
  topic: string;
  page: number;
  totalPages: number;
  timestamp?: string;
  source: string;
  score: number;
  title?: string;
  excerpt: string;
}

/** Model-safe view over the runtime references catalog for discovery and selection. */
export interface ReferenceChild {
  readonly name: string;
  readonly kind: "file" | "directory";
}

export const MAX_REFERENCE_CHILDREN = 300;
const EXCLUDED_REFERENCE_CHILD_NAMES = new Set(["node_modules", ".git"]);

export interface ReferenceCatalogReader {
  read: () => Promise<ReferenceCatalogReadResult>;
  listChildren?: (root: string) => Promise<readonly ReferenceChild[]>;
}

type WikiSearchDetails = {
  mode: "wikis";
  query?: string;
  topic?: string;
  results: KnowledgeSearchResultItem[];
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
      truncated?: boolean;
    }>;
  };
};

type ReferenceSearchDetails = {
  mode: "references";
  query?: string;
  aliases: Array<{
    alias: string;
    type: "local" | "git";
    description?: string;
    status: string;
    diagnostic?: string;
  }>;
  selection?: {
    alias: string;
    type: "local" | "git";
    description?: string;
    hidden?: boolean;
    root: string;
    children: ReferenceChild[];
    truncated?: boolean;
    total?: number;
    excluded: number;
    handoff: string;
  };
  diagnostics?: string[];
};

export type KnowledgeSearchDetails =
  | WikiSearchDetails
  | ReferenceSearchDetails
  | {
      mode: "discovery";
      query: string;
      references: ReferenceSearchDetails;
      wikis: WikiSearchDetails;
    }
  | {
      mode: "error";
      message: string;
    };

export interface KnowledgeSearchExecutionOptions {
  wikiRoot?: string;
  projectRoot?: string;
  sessionId?: string;
  rootSessionId?: string;
  nowMs?: () => number;
  referenceCatalog?: ReferenceCatalogReader;
  signal?: AbortSignal;
}

/** Register the local-first knowledge and reference research tool. */
export function registerKnowledgeSearchTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "knowledge_search",
    label: "Knowledge search",
    description:
      "Use this tool first to search local wikis and references for reusable research. It searches the local knowledge cache and configured reference roots before any web research. Call with {} (or just query=\"*\", no type) for grouped discovery: the response renders a --references-- section first and a --wikis-- section second, so you can see available reference aliases and wiki topics in one call. Use type=\"wikis\" to search the local wiki cache with a broad-to-specific workflow: first run a broad query without topic/page (for example, query=\"pi\") to discover available topics and page identifiers; use query=\"*\" to list available wiki topics and pages; then use the returned topic and page values with a narrower query or direct topic/page lookup to retrieve targeted evidence. Use type=\"references\" to work with configured reference aliases representing the actual codebase or repository source code and relevant Markdown documentation, so you can learn directly from the referenced project materials. Use query=\"*\" to list discoverable aliases (descriptions and source kinds included), then call again with the chosen alias to select its readable root; after a root is selected, inspect the project materials with normal filesystem tools such as read, grep, and find rather than searching it here. Only when local results are absent, insufficient, or time-sensitive should you fall back to web_search for broad web discovery. Once web_search identifies candidate URLs, use web_fetch for subsequent retrieval and verification because web_fetch is free. Successful web results are saved automatically for future wiki searches. Treat cached content as potentially stale and verify version-sensitive claims against current web sources.",
    parameters: knowledgeSearchParams,
    async execute(
      _toolCallId: string,
      params: KnowledgeSearchParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<KnowledgeSearchDetails>> {
      return processWithLog({ operation: TOOL_OPERATIONS.KNOWLEDGE_SEARCH_EXECUTE, parameters: { type: params.type, query: (params as { query?: unknown }).query } }, async () =>
        executeKnowledgeSearch(params, {
          signal,
          ...(_ctx?.cwd ? { projectRoot: _ctx.cwd } : {}),
          ...(_ctx?.sessionManager?.getSessionId?.() ? { sessionId: _ctx.sessionManager.getSessionId() } : {}),
          ...(_ctx?.cwd && _ctx?.sessionManager?.getSessionId?.()
            ? { rootSessionId: getChildPool(_ctx.cwd, _ctx.sessionManager.getSessionId()).rootSessionIdFor(_ctx.sessionManager.getSessionId()) }
            : {}),
        }),
      );
    },
  });
}

function signalAborted(options?: KnowledgeSearchExecutionOptions): boolean {
  return Boolean(options?.signal?.aborted);
}

export async function executeKnowledgeSearch(
  params: KnowledgeSearchParams,
  options?: KnowledgeSearchExecutionOptions,
): Promise<AgentToolResult<KnowledgeSearchDetails>> {
  if (params.type === undefined || params.type === null) {
    const rawParams = params as Record<string, unknown>;
    if (rawParams.alias !== undefined || rawParams.topic !== undefined || rawParams.page !== undefined || rawParams.maxResults !== undefined) {
      return errorResult("Only query may be used without a type.", {
        mode: "error",
        message: "Only query may be used without a type.",
      });
    }
    const query = typeof rawParams.query === "string" && rawParams.query.length > 0 ? rawParams.query : "*";
    const references = await executeKnowledgeSearch({ type: "references", query: "*" }, options);
    if (references.details.mode === "error") return references;
    const wikis = await executeKnowledgeSearch({ type: "wikis", query }, options);
    if (wikis.details.mode === "error") return wikis;
    const referenceDetails = references.details as ReferenceSearchDetails;
    const wikiDetails = wikis.details as WikiSearchDetails;
    const referenceText = references.content.find((item) => item.type === "text")?.text ?? "";
    const wikiText = wikis.content.find((item) => item.type === "text")?.text ?? "";
    return textResult(
      [
        "--references--",
        referenceText,
        "---",
        "--wikis--",
        wikiText,
      ].join("\n"),
      {
        mode: "discovery",
        query,
        references: referenceDetails,
        wikis: wikiDetails,
      },
    );
  }
  if (params.type !== "wikis" && params.type !== "references") {
    return errorResult("Unsupported knowledge_search type.", { mode: "error", message: "Unsupported knowledge_search type." });
  }
  if (params.type === "wikis" && params.alias !== undefined) {
    return errorResult("The 'alias' field is only valid for type=references.", {
      mode: "error",
      message: "The 'alias' field is only valid for type=references.",
    });
  }
  if (params.type === "references" && (params.topic !== undefined || params.page !== undefined)) {
    return errorResult("The 'topic' and 'page' fields are only valid for type=wikis.", {
      mode: "error",
      message: "The 'topic' and 'page' fields are only valid for type=wikis.",
    });
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
    if (params.alias !== undefined) {
      const entry = read.entries.find((candidate) => candidate.name === params.alias);
      if (!entry) {
        return textResult(`Reference alias '${params.alias}' was not found in the configured catalog.`, {
          mode: "references",
          ...(params.query === undefined ? {} : { query: params.query }),
          aliases: [],
          diagnostics: ["Reference alias was not found"],
        });
      }
      if (entry.status !== "available" || !entry.path) {
        return textResult(`Reference alias '${entry.name}' is unavailable.`, {
          mode: "references",
          ...(params.query === undefined ? {} : { query: params.query }),
          aliases: [],
          diagnostics: [entry.diagnostic ?? "Reference root is unavailable"],
        });
      }
      if (signalAborted(options)) {
        return errorResult("Reference research aborted.", { mode: "error", message: "Reference research aborted." });
      }
      let children: readonly ReferenceChild[];
      try {
        children = options?.referenceCatalog?.listChildren
          ? await options.referenceCatalog.listChildren(entry.path)
          : await listReferenceChildren(entry.path);
      } catch {
        return textResult(`Unable to list reference alias '${entry.name}'.`, {
          mode: "references",
          ...(params.query === undefined ? {} : { query: params.query }),
          aliases: [],
          diagnostics: ["Unable to list the reference root"],
        });
      }
      const canonical = normalizeReferenceChildren(children);
      const excluded = canonical.filter((child) => EXCLUDED_REFERENCE_CHILD_NAMES.has(child.name)).length;
      const visible = canonical.filter((child) => !EXCLUDED_REFERENCE_CHILD_NAMES.has(child.name));
      const truncated = visible.length > MAX_REFERENCE_CHILDREN;
      const selectionChildren = truncated ? visible.slice(0, MAX_REFERENCE_CHILDREN) : visible;
      const selection = {
        alias: entry.name,
        type: entry.source.type,
        ...(entry.description ? { description: entry.description } : {}),
        ...(entry.hidden === undefined ? {} : { hidden: entry.hidden }),
        root: entry.path,
        children: selectionChildren,
        ...(truncated ? { truncated: true, total: visible.length } : {}),
        excluded,
        handoff: "Use normal filesystem tools such as read, grep, and find for focused inspection of this root.",
      };
      const renderedChildren = selection.children.length === 0
        ? "  (empty root)"
        : selection.children.map((child) => `  - ${child.name} (${child.kind})`).join("\n");
      const truncatedNote = truncated ? `\n  ... and ${visible.length - MAX_REFERENCE_CHILDREN} more entries omitted` : "";
      return textResult(
        [`Reference: ${selection.alias} (${selection.type})`, `Root: ${selection.root}`, "Immediate children:", renderedChildren + truncatedNote, selection.handoff].join("\n"),
        {
          mode: "references",
          ...(params.query === undefined ? {} : { query: params.query }),
          aliases: [],
          selection,
        },
      );
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
  if (signalAborted(options)) {
    return errorResult("Wiki research aborted.", { mode: "error", message: "Wiki research aborted." });
  }
  const root = options?.wikiRoot ?? wikiRoot();
  if (params.topic !== undefined && params.page !== undefined) {
    const page = await retrieveWikiPage(root, params.topic, params.page, options);
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
      maxResults: params.maxResults,
      history: options,
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
    const lines: string[] = [];
    let renderedBytes = 0;
    let truncated = false;
    const appendLine = (line: string): boolean => {
      const separatorBytes = lines.length === 0 ? 0 : 1;
      const available = MAX_WIKI_DISCOVERY_OUTPUT_BYTES - renderedBytes - separatorBytes;
      if (available <= 0) {
        truncated = true;
        return false;
      }
      const bounded = truncateUtf8(line, available);
      lines.push(bounded);
      renderedBytes += separatorBytes + Buffer.byteLength(bounded, "utf8");
      if (bounded.length !== line.length) truncated = true;
      return bounded.length === line.length;
    };
    outer: {
      for (const topic of topics) {
        if (!appendLine(`Topic: ${topic.topic}`)) break outer;
        for (const page of topic.pages) {
          if (!appendLine(`  - ${page.file}`)) break outer;
        }
      }
    }
    let textRendered = lines.join("\n");
    if (truncated) {
      const suffix = "... discovery output truncated";
      const separatorBytes = textRendered.length === 0 ? 0 : 1;
      const available = MAX_WIKI_DISCOVERY_OUTPUT_BYTES - Buffer.byteLength(textRendered, "utf8") - separatorBytes;
      if (available > 0) {
        const boundedSuffix = truncateUtf8(suffix, available);
        textRendered = textRendered.length === 0 ? boundedSuffix : `${textRendered}\n${boundedSuffix}`;
      }
    }
    return textResult(textRendered, {
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

async function listReferenceChildren(root: string): Promise<ReferenceChild[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries.map((entry) => ({
    name: entry.name,
    kind: entry.isDirectory() ? "directory" : "file",
  }));
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end--;
  return value.slice(0, end);
}

function normalizeReferenceChildren(children: readonly ReferenceChild[]): ReferenceChild[] {
  return children
    .filter((child) => child.kind === "file" || child.kind === "directory")
    .map((child) => ({ name: child.name, kind: child.kind }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind));
}

export { knowledgeSearchParams };
