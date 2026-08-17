import { readdir } from "node:fs/promises";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderToolDetail, renderToolOutcome, toolResultFailed, toolResultText } from "../render.ts";
import { Type } from "typebox";
import { TOOL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { createReferenceCatalog, getChildPool, type ReferenceCatalogReadResult } from "@xzy-ai/runtime";
import { errorResult, textResult } from "../results.ts";
import {
  discoverWikiTopics,
  MAX_WIKI_DISCOVERY_OUTPUT_BYTES,
  retrieveWikiPageByFile,
  topicFromPageFile,
  searchWikis,
  wikiRoot,
} from "../wiki.ts";

// Keep this as one plain object with optional scalar properties. Some model
// providers reject top-level unions/anyOf and nullable optional properties even
// when they are valid JSON Schema. The executor below remains authoritative for
// combinations such as page+query and alias on a wiki request.
const knowledgeSearchParams = Type.Object({
  type: Type.Optional(Type.String({ description: "Search scope: \"wikis\" or \"references\". Omit for grouped discovery." })),
  query: Type.Optional(Type.String({ description: "Search query, or \"*\" for deterministic discovery; omit when opening a page directly." })),
  page: Type.Optional(Type.String({ description: "Open a saved wiki page directly by its file path; use only with type=\"wikis\" and without query." })),
  alias: Type.Optional(Type.String({ description: "Configured reference alias to select a readable root; use only with type=\"references\"." })),
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum wiki results or topics to return." })),
}, { additionalProperties: false });

export type KnowledgeSearchType = "wikis" | "references";

type KnowledgeSearchParams = {
  type?: string | null;
  query?: string;
  page?: string;
  alias?: string;
  maxResults?: number;
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
  /** Topic of the opened page when the request used the page selector. */
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
        title?: string;
        openCount?: number;
        lastOpened?: number;
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
      "Use this tool first to search local wikis and references for reusable research before any web research. It searches the local knowledge cache and configured reference roots. Call with no type (or query=\"*\") for grouped discovery (broad-to-specific): --references-- first, --wikis-- second. Use type=\"wikis\" with query=\"*\" to browse topics, a normal query for ranked files, or page (without query) to open the full saved page directly by its returned file path; the response includes the relevant topic and page path. Use type=\"references\" to list aliases or to select a root for read/grep/find inspection. Search output is identification only - never reason from excerpts, snippets, or fragments; always open and read the complete page or source root first, because incomplete portions can cause hallucinations. Only when local results are absent, insufficient, or time-sensitive should you fall back to web_search; then use web_fetch to retrieve and verify candidate URLs, since web_fetch is free. Treat cached results as potentially stale and verify sensitive claims against current web sources.",
    parameters: knowledgeSearchParams,
    async execute(
      _toolCallId: string,
      params: KnowledgeSearchParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<KnowledgeSearchDetails>> {
      return processWithLog(
        { operation: TOOL_OPERATIONS.KNOWLEDGE_SEARCH_EXECUTE, parameters: { type: params.type, query: (params as { query?: unknown }).query }, sanitizeResult: omitKnowledgeSearchResult },
        async () =>
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
    renderCall(args, theme, context) {
      const query = typeof args.query === "string" ? args.query : "discovering local knowledge";
      return renderToolDetail(theme, "knowledge_search", query, 96, context, args);
    },
    renderResult(result, options, theme, context) {
      const failed = toolResultFailed(result, context);
      const details = result.details as { results?: unknown[]; page?: { file?: unknown } } | undefined;
      const pageFile = typeof details?.page?.file === "string" ? details.page.file : undefined;
      const label = pageFile ? `Read: ${pageFile}` : `Knowledge search • ${details?.results?.length ?? (toolResultText(result) ? 1 : 0)} results`;
      return renderToolOutcome(theme, label, { ...options, expanded: Boolean(context.expanded ?? options.expanded), ...(pageFile ? { successMarker: false, expandedLabel: false } : {}) }, failed, toolResultText(result), result, context.args);
    },
  });
}

function signalAborted(options?: KnowledgeSearchExecutionOptions): boolean {
  return Boolean(options?.signal?.aborted);
}

/**
 * Keep callback results out of telemetry: the knowledge-search result embeds
 * wiki bodies, search excerpts, reference roots, and history-derived discovery
 * metadata (titles, counts, timestamps) that must never be persisted.
 */
function omitKnowledgeSearchResult(_result: unknown): undefined {
  return undefined;
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
  if (params.type === "references" && params.page !== undefined) {
    return errorResult("The 'page' field is only valid for type=wikis.", {
      mode: "error",
      message: "The 'page' field is only valid for type=wikis.",
    });
  }
  if (params.type === "references" && (params as { topic?: unknown }).topic !== undefined) {
    return errorResult("The 'topic' field is not supported; use query or page.", {
      mode: "error",
      message: "The 'topic' field is not supported; use query or page.",
    });
  }
  if (params.type === "wikis" && (params as { topic?: unknown }).topic !== undefined) {
    return errorResult("The 'topic' field is not supported; use query or page.", {
      mode: "error",
      message: "The 'topic' field is not supported; use query or page.",
    });
  }
  if (params.type === "wikis" && params.page !== undefined && params.query !== undefined) {
    return errorResult("The 'query' field cannot be combined with direct page opening.", {
      mode: "error",
      message: "The 'query' field cannot be combined with direct page opening.",
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
          `- ${alias.alias} (${alias.type})`,
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
  if (params.page !== undefined) {
    const page = await retrieveWikiPageByFile(root, params.page, options);
    if (!page) {
      return textResult("No local wiki matches found.", {
        mode: "wikis",
        ...(params.query === undefined ? {} : { query: params.query }),
        topic: topicFromPageFile(params.page),
        results: [],
      });
    }
    return textResult(page.content, {
      mode: "wikis",
      ...(params.query === undefined ? {} : { query: params.query }),
      topic: page.topic,
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
      maxResults: params.maxResults,
      history: options,
    });
    if (topics.length === 0) {
      return textResult("No local wiki pages found.", {
        mode: "wikis",
        query,
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
        if (topic.pages.length > 1 && !appendLine(`Topic: ${topic.topic}`)) break outer;
        for (const page of topic.pages) {
          const metadata = page.openCount === undefined ? "" : `openCount: ${page.openCount}`;
          const prefix = topic.pages.length > 1 ? "  - " : "- ";
          if (!appendLine(`${prefix}${page.file}${metadata ? ` (${metadata})` : ""}`)) break outer;
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
      results: [],
      discovery: { topics },
    });
  }
  const results = await searchWikis(root, query, {
    max: params.maxResults,
  });
  if (results.length === 0) {
    return textResult("No local wiki matches found.", {
      mode: "wikis",
      ...(params.query === undefined ? {} : { query: params.query }),
      results: [],
    });
  }
  const rendered = [...new Map(results.map((item) => [item.file, item])).values()]
    .map((item) => `- ${item.file} (${item.score})`)
    .join("\n");
  return textResult(rendered, {
    mode: "wikis",
    ...(params.query === undefined ? {} : { query: params.query }),
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
