import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { TOOL_OPERATIONS, createSessionLogger, runWithLogContext } from "@xzy-ai/observability";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  executeKnowledgeSearch,
  registerKnowledgeSearchTool,
  MAX_REFERENCE_CHILDREN,
  type ReferenceCatalogReader,
} from "../src/registrations/knowledge-search.ts";
import {
  formatWikiEntry,
  saveWikiEntry,
  MAX_WIKI_DISCOVERY_OUTPUT_BYTES,
  MAX_WIKI_DISCOVERY_PAGES,
} from "../src/wiki.ts";
import { homeRoot, homeSessionDirFromRoot } from "@xzy-ai/runtime";

type Tool = {
  name: string;
  description: string;
  parameters: { type?: string; properties?: Record<string, { type?: string; anyOf?: unknown[] }>; anyOf?: unknown[] };
  execute: (...args: unknown[]) => Promise<{
    content: Array<{ type: string; text?: string }>;
    details: Record<string, unknown>;
  }>;
};

const context = {} as ExtensionContext;

function captureTool(): Tool {
  let registered: Tool | undefined;
  registerKnowledgeSearchTool({
    registerTool(tool: Tool) {
      registered = tool;
    },
  } as unknown as ExtensionAPI);
  assert.ok(registered);
  return registered;
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  assert.equal(block?.type, "text");
  return block.text ?? "";
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-c2-wikis-search-"));
}

test("wiki save emits a boundary without persisting entry content as telemetry parameters", async () => {
  const root = tempRoot();
  const logRoot = tempRoot();
  const logger = createSessionLogger({
    projectId: "project",
    rootSessionId: "root-session",
    eventsPath: join(logRoot, "events.jsonl"),
    errorsPath: join(logRoot, "errors.jsonl"),
  });
  await runWithLogContext(logger, async () => {
    const result = await saveWikiEntry({
      topic: "telemetry",
      source: "web_search",
      queryOrUrl: "query",
      format: "markdown",
      title: "Title",
      text: "WIKI-SECRET-CONTENT",
      root,
    });
    assert.equal(result.saved, true);
  });
  const records = readFileSync(join(logRoot, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const wikiRecords = records.filter((record) => record.operation === TOOL_OPERATIONS.WIKI_EXECUTE);
  assert.deepEqual(wikiRecords.map((record) => record.phase), ["before", "after"]);
  assert.ok(!JSON.stringify(wikiRecords).includes("WIKI-SECRET-CONTENT"));
  rmSync(root, { recursive: true, force: true });
  rmSync(logRoot, { recursive: true, force: true });
});

test("knowledge_search telemetry excludes callback results and history-derived discovery metadata", async () => {
  const projectRoot = tempRoot();
  const previousHome = process.env.PI_C2_HOME;
  process.env.PI_C2_HOME = projectRoot;
  const wikiRoot = join(homeRoot(), "wikis");
  mkdirSync(wikiRoot, { recursive: true });
  let tool: Tool | undefined;
  registerKnowledgeSearchTool({ registerTool(candidate: Tool) { tool = candidate; } } as unknown as ExtensionAPI);
  const logRoot = tempRoot();
  const logger = createSessionLogger({
    projectId: "knowledge-search-project",
    rootSessionId: "root-a",
    eventsPath: join(logRoot, "events.jsonl"),
    errorsPath: join(logRoot, "errors.jsonl"),
  });
  try {
    assert.ok(tool);
    const ctx = { cwd: projectRoot, sessionManager: { getSessionId: () => "root-a" } } as unknown as ExtensionContext;
    await runWithLogContext(logger, async () => {
      const saved = await saveWikiEntry({
        topic: "telemetry",
        source: "web_search",
        queryOrUrl: "telemetry-query",
        format: "markdown",
        title: "History secret title",
        text: "History secret body",
        timestamp: "2026-01-01T00:00:00.000Z",
        root: wikiRoot,
      });
      assert.equal(saved.saved, true);
      const search = await tool!.execute("search", { type: "wikis", query: "telemetry query terms" }, undefined, undefined, ctx);
      const searchDetails = search.details as unknown as { results: Array<Record<string, unknown>> };
      assert.deepEqual(searchDetails.results.map((item) => item.file), ["telemetry.md"]);
      const direct = await tool!.execute("direct", { type: "wikis", page: "telemetry.md" }, undefined, undefined, ctx);
      assert.match(text(direct), /History secret body/);
      const discovery = await tool!.execute("discovery", { type: "wikis", query: "*" }, undefined, undefined, ctx);
      assert.match(text(discovery), /telemetry\.md.*openCount: 1/);
      assert.doesNotMatch(text(discovery), /History secret title|lastOpened/);
    });
    const historyFile = join(homeSessionDirFromRoot(projectRoot, "root-a"), "wiki-history.json");
    const historyRecords = JSON.parse(readFileSync(historyFile, "utf8") as string) as { r: Array<[string, string, number, number]> };
    assert.equal(historyRecords.r.length, 1);
    assert.deepEqual(historyRecords.r[0], ["telemetry", "telemetry.md", 1, historyRecords.r[0]![3]]);

    const records = readFileSync(join(logRoot, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const knowledgeRecords = records.filter((record) => record.operation === TOOL_OPERATIONS.KNOWLEDGE_SEARCH_EXECUTE);
    assert.equal(knowledgeRecords.length, 6);
    assert.equal(knowledgeRecords.every((record) => !("result" in record)), true);
    assert.deepEqual(knowledgeRecords.filter((record) => record.phase === "before").map((record) => record.parameters), [
      { type: "wikis", query: "telemetry query terms" },
      { type: "wikis" },
      { type: "wikis", query: "*" },
    ]);
    const raw = JSON.stringify(knowledgeRecords);
    assert.doesNotMatch(raw, /telemetry\.md|History secret title|History secret body|openCount|lastOpened|wiki-history\.json/);
  } finally {
    process.env.PI_C2_HOME = previousHome;
    rmSync(logRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("knowledge_search is registered with an explicit type discriminator and a local-first description", () => {
  const tool = captureTool();
  assert.equal(tool.name, "knowledge_search");
  const variants = tool.parameters.anyOf ?? [];
  assert.equal(variants.length, 3);
  const literals = variants.map((variant) => {
    const typeField = (variant as { properties?: { type?: { const?: string } } }).properties?.type;
    return typeField?.const;
  });
  assert.deepEqual(literals, ["wikis", "references", undefined]);
  const grouped = variants[2] as { properties?: Record<string, { const?: string; type?: string; anyOf?: unknown[] }> };
  assert.equal(grouped.properties?.query?.type, "string");
  assert.equal(grouped.properties?.type?.type, "null");
  assert.match(tool.description, /wikis/i);
  assert.match(tool.description, /references/i);
  assert.match(tool.description, /Use this tool first/i);
  assert.match(tool.description, /local wikis and references/i);
  assert.match(tool.description, /before any web research/i);
  assert.match(tool.description, /web_search/);
  assert.match(tool.description, /web_fetch/);
  assert.match(tool.description, /web_fetch.*free/i);
  assert.match(tool.description, /broad-to-specific/i);
  assert.match(tool.description, /page.*returned file path/i);
  assert.match(tool.description, /without query/);
  assert.match(tool.description, /local knowledge cache/i);
  assert.match(tool.description, /time-sensitive/i);
  assert.match(tool.description, /never reason from excerpts/i);
  assert.match(tool.description, /complete page or source root/i);
});

test("knowledge_search routes an unsupported type to a safe error", async () => {
  const result = await executeKnowledgeSearch({ type: "invalid" as never });
  assert.match(text(result), /Error/);
});

test("knowledge_search returns an empty structured result for an absent wiki directory", async () => {
  const root = join(tempRoot(), "missing");
  try {
    const result = await executeKnowledgeSearch({ type: "wikis", query: "typescript" }, { wikiRoot: root });
    assert.equal(text(result), "No local wiki matches found.");
    assert.deepEqual(result.details, { mode: "wikis", query: "typescript", results: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge_search returns an empty structured result for an empty wiki directory", async () => {
  const root = tempRoot();
  mkdirSync(root, { recursive: true });
  try {
    const result = await executeKnowledgeSearch(
      { type: "wikis", page: "typescript-notes.md", maxResults: 50 },
      { wikiRoot: root },
    );
    assert.equal(text(result), "No local wiki matches found.");
    assert.deepEqual(result.details, { mode: "wikis", topic: "typescript-notes", results: [] });
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge_search returns deterministically ranked excerpts with scores and metadata", async () => {
  const root = tempRoot();
  const file = join(root, "typescript-notes.md");
  writeFileSync(
    file,
    formatWikiEntry({
      topic: "typescript-notes",
      source: "web_search",
      queryOrUrl: "typescript",
      format: "markdown",
      title: "TypeScript heading",
      text: "body without the token",
      timestamp: "2026-01-01T00:00:00.000Z",
    }) +
      formatWikiEntry({
        topic: "typescript-notes",
        source: "web_fetch",
        queryOrUrl: "https://example.com/other",
        format: "markdown",
        title: "Other title",
        text: "typescript in body",
        timestamp: "2026-01-02T00:00:00.000Z",
      }),
  );
  try {
    const result = await executeKnowledgeSearch({ type: "wikis", query: "typescript" }, { wikiRoot: root });
    const details = result.details as unknown as unknown as { results: Array<Record<string, unknown>> };
    assert.equal(details.results.length, 2);
    assert.equal(details.results[0]?.score, 0.254095);
    assert.equal(details.results[1]?.score, 0.178838);
    assert.equal(details.results[0]?.file, "typescript-notes.md");
    assert.equal(details.results[0]?.source, "web_search");
    assert.equal(typeof details.results[0]?.excerpt, "string");
    assert.match(text(result), /typescript-notes\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge_search searches natural-language queries and continuation pages", async () => {
  const root = tempRoot();
  writeFileSync(
    join(root, "react-notes.md"),
    formatWikiEntry({ topic: "react-notes", source: "web_search", queryOrUrl: "react", format: "markdown", title: "React", text: "hooks", timestamp: "2026-01-01T00:00:00.000Z" }),
  );
  writeFileSync(
    join(root, "react-notes.part-002.md"),
    formatWikiEntry({ topic: "react-notes", source: "web_fetch", queryOrUrl: "https://react.dev", format: "markdown", title: "React docs", text: "hooks", timestamp: "2026-01-02T00:00:00.000Z" }),
  );
  writeFileSync(
    join(root, "vue-notes.md"),
    formatWikiEntry({ topic: "vue-notes", source: "web_search", queryOrUrl: "vue", format: "markdown", title: "Vue", text: "composition", timestamp: "2026-01-03T00:00:00.000Z" }),
  );
  try {
    const result = await executeKnowledgeSearch({ type: "wikis", query: "hooks" }, { wikiRoot: root });
    const details = result.details as unknown as unknown as { results: Array<Record<string, unknown>> };
    assert.equal(details.results.length, 2);
    assert.deepEqual(details.results.map((item) => item.file), ["react-notes.md", "react-notes.part-002.md"]);
    assert.equal(details.results.every((item) => String(item.file).startsWith("react-notes")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge_search defaults to 20 results and caps at the 50 maximum", async () => {
  const root = tempRoot();
  const entries = Array.from({ length: 55 }, (_, index) =>
    formatWikiEntry({
      topic: "limits",
      source: "web_search",
      queryOrUrl: `limits ${index}`,
      format: "markdown",
      title: `Limits ${index}`,
      text: `limits ${index}`,
      timestamp: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    }),
  ).join("");
  writeFileSync(join(root, "limits.md"), entries);
  try {
    const defaultResult = await executeKnowledgeSearch({ type: "wikis", query: "limits" }, { wikiRoot: root });
    const defaultDetails = defaultResult.details as unknown as { results: Array<Record<string, unknown>> };
    assert.equal(defaultDetails.results.length, 20);

    const maxResult = await executeKnowledgeSearch({ type: "wikis", query: "limits", maxResults: 50 }, { wikiRoot: root });
    const maxDetails = maxResult.details as unknown as { results: Array<Record<string, unknown>> };
    assert.equal(maxDetails.results.length, 50);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge_search bounds each excerpt to approximately 2 KB and the aggregate output", async () => {
  const root = tempRoot();
  const longText = `typescript ${"padding ".repeat(3000)}`;
  writeFileSync(
    join(root, "long.md"),
    formatWikiEntry({
      topic: "long",
      source: "web_search",
      queryOrUrl: "long",
      format: "markdown",
      title: "Long",
      text: longText,
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
  );
  try {
    const result = await executeKnowledgeSearch({ type: "wikis", query: "typescript" }, { wikiRoot: root });
    const details = result.details as unknown as unknown as { results: Array<Record<string, unknown>> };
    assert.equal(details.results.length, 1);
    assert.ok(String(details.results[0]?.excerpt).length <= 2048);
    assert.ok(text(result).length <= 64 * 1024);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge_search breaks equal scores by newest timestamp then filename", async () => {
  const root = tempRoot();
  const entry = (title: string, timestamp: string) =>
    formatWikiEntry({ topic: "ties", source: "web_search", queryOrUrl: "ties", format: "markdown", title, text: "ties", timestamp });
  writeFileSync(join(root, "zeta.md"), entry("Zeta", "2026-01-02T00:00:00.000Z"));
  writeFileSync(join(root, "alpha.md"), entry("Alpha", "2026-01-02T00:00:00.000Z"));
  try {
    const result = await executeKnowledgeSearch({ type: "wikis", query: "ties" }, { wikiRoot: root });
    const details = result.details as unknown as unknown as { results: Array<Record<string, unknown>> };
    assert.deepEqual(details.results.map((item) => item.file), ["alpha.md", "zeta.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge_search opens a saved page directly via its file path without a query or topic", async () => {
  const root = tempRoot();
  writeFileSync(
    join(root, "alpha.md"),
    `<!-- pi-c2-wiki-page -->\ntopic: alpha\npage: 1\ntotalPages: 2\nnext: alpha.part-002.md\n\n<!-- pi-c2-wiki-page-end -->\n\nFULL ALPHA PAGE`,
  );
  writeFileSync(
    join(root, "alpha.part-002.md"),
    `<!-- pi-c2-wiki-page -->\ntopic: alpha\npage: 2\ntotalPages: 2\nprevious: alpha.md\n\n<!-- pi-c2-wiki-page-end -->\n\nFULL SECOND PAGE`,
  );
  try {
    const first = await executeKnowledgeSearch({ type: "wikis", page: "alpha.md" }, { wikiRoot: root });
    assert.match(text(first), /FULL ALPHA PAGE/);
    const firstDetails = first.details as unknown as { topic: string; page: { topic: string; file: string } };
    assert.equal(firstDetails.topic, "alpha");
    assert.equal(firstDetails.page.topic, "alpha");
    assert.equal(firstDetails.page.file, "alpha.md");
    const second = await executeKnowledgeSearch({ type: "wikis", page: "alpha.part-002.md" }, { wikiRoot: root });
    assert.match(text(second), /FULL SECOND PAGE/);
    const missing = await executeKnowledgeSearch({ type: "wikis", page: "alpha.part-099.md" }, { wikiRoot: root });
    assert.equal(text(missing), "No local wiki matches found.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge_search retrieves a complete page with metadata without requiring a query", async () => {
  const root = tempRoot();
  writeFileSync(
    join(root, "react.md"),
    `<!-- pi-c2-wiki-page -->\ntopic: react\npage: 1\ntotalPages: 2\nnext: react.part-002.md\n\n[Next](./react.part-002.md)\n<!-- pi-c2-wiki-page-end -->\n\nFULL PAGE ONE\n${formatWikiEntry({ topic: "react", source: "web_search", queryOrUrl: "react", format: "markdown", title: "React", text: "one", timestamp: "2026-01-01T00:00:00.000Z" })}`,
  );
  writeFileSync(
    join(root, "react.part-002.md"),
    `<!-- pi-c2-wiki-page -->\ntopic: react\npage: 2\ntotalPages: 2\nprevious: react.md\n\n[Previous](./react.md)\n<!-- pi-c2-wiki-page-end -->\n\nFULL PAGE TWO`,
  );
  try {
    const result = await executeKnowledgeSearch({ type: "wikis", page: "react.part-002.md" }, { wikiRoot: root });
    assert.equal(text(result), readFileSync(join(root, "react.part-002.md"), "utf8"));
    const details = result.details as unknown as Record<string, unknown>;
    assert.deepEqual(details.page, {
      file: "react.part-002.md",
      topic: "react",
      page: 2,
      totalPages: 2,
      previous: "react.md",
    });
    assert.equal("query" in details, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge_search wildcard discovers topics and continuation pages without matching content", async () => {
  const root = tempRoot();
  writeFileSync(
    join(root, "alpha.md"),
    `<!-- pi-c2-wiki-page -->\ntopic: alpha\npage: 1\ntotalPages: 2\nnext: alpha.part-002.md\n\n<!-- pi-c2-wiki-page-end -->\n\nsecret-token-never-returned`,
  );
  writeFileSync(
    join(root, "alpha.part-002.md"),
    `<!-- pi-c2-wiki-page -->\ntopic: alpha\npage: 2\ntotalPages: 2\nprevious: alpha.md\n\n<!-- pi-c2-wiki-page-end -->\n\nmore-secret-content`,
  );
  writeFileSync(
    join(root, "beta.md"),
    `<!-- pi-c2-wiki-page -->\ntopic: beta\npage: 1\ntotalPages: 1\n\n<!-- pi-c2-wiki-page-end -->\n\nbody without a search token`,
  );
  try {
    const result = await executeKnowledgeSearch({ type: "wikis", query: "*" }, { wikiRoot: root });
    const details = result.details as unknown as { discovery: { topics: Array<{ topic: string; pages: Array<Record<string, unknown>> }> } };
    assert.deepEqual(details.discovery.topics.map((topic) => topic.topic), ["alpha", "beta"]);
    assert.deepEqual(details.discovery.topics[0]?.pages.map((page) => page.file), ["alpha.md", "alpha.part-002.md"]);
    assert.deepEqual(details.discovery.topics[0]?.pages[0], {
      file: "alpha.md",
      page: 1,
      totalPages: 2,
      next: "alpha.part-002.md",
      title: "Alpha",
    });
    assert.deepEqual(details.discovery.topics[0]?.pages[1], {
      file: "alpha.part-002.md",
      page: 2,
      totalPages: 2,
      previous: "alpha.md",
      title: "Alpha",
    });
    assert.match(text(result), /alpha\.part-002\.md/);
    assert.doesNotMatch(text(result), /secret-token|more-secret-content/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge_search wildcard has deterministic bounded discovery output", async () => {
  const root = tempRoot();
  for (let index = 55; index >= 1; index--) {
    writeFileSync(
      join(root, `topic-${String(index).padStart(2, "0")}.md`),
      `<!-- pi-c2-wiki-page -->\ntopic: topic-${String(index).padStart(2, "0")}\npage: 1\ntotalPages: 1\n\n<!-- pi-c2-wiki-page-end -->`,
    );
  }
  try {
    const result = await executeKnowledgeSearch({ type: "wikis", query: "*", maxResults: 20 }, { wikiRoot: root });
    const details = result.details as unknown as { discovery: { topics: Array<{ topic: string }> } };
    assert.equal(details.discovery.topics.length, 20);
    assert.deepEqual(details.discovery.topics.map((topic) => topic.topic), Array.from({ length: 20 }, (_, index) => `topic-${String(index + 1).padStart(2, "0")}`));
    assert.ok(text(result).length <= 64 * 1024);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge_search wildcard handles absent, empty, malformed, and unreadable roots safely", async () => {
  const missing = await executeKnowledgeSearch({ type: "wikis", query: "*" }, { wikiRoot: join(tempRoot(), "missing") });
  assert.equal(text(missing), "No local wiki pages found.");
  assert.deepEqual((missing.details as unknown as { discovery: unknown }).discovery, { topics: [] });

  const emptyRoot = tempRoot();
  try {
    const empty = await executeKnowledgeSearch({ type: "wikis", query: "*" }, { wikiRoot: emptyRoot });
    assert.equal(text(empty), "No local wiki pages found.");
    assert.deepEqual((empty.details as unknown as { discovery: unknown }).discovery, { topics: [] });
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true });
  }

  const malformedRoot = tempRoot();
  writeFileSync(join(malformedRoot, "malformed.md"), "not a wiki page");
  try {
    const malformed = await executeKnowledgeSearch({ type: "wikis", query: "*" }, { wikiRoot: malformedRoot });
    assert.equal(text(malformed), "No local wiki pages found.");
    assert.deepEqual((malformed.details as unknown as { discovery: unknown }).discovery, { topics: [] });
  } finally {
    rmSync(malformedRoot, { recursive: true, force: true });
  }

  const fileRoot = join(tempRoot(), "not-a-directory.md");
  writeFileSync(fileRoot, "not a directory");
  const unreadable = await executeKnowledgeSearch({ type: "wikis", query: "*" }, { wikiRoot: fileRoot });
  assert.equal(text(unreadable), "No local wiki pages found.");
  assert.deepEqual((unreadable.details as unknown as { discovery: unknown }).discovery, { topics: [] });
});

type FakeReferenceSource =
  | { type: "local"; description?: string; hidden?: boolean; path?: string }
  | { type: "git"; description?: string; hidden?: boolean; repository?: string; branch?: string };

type FakeReferenceChild = { name: string; kind: "file" | "directory" };

type FakeReferenceEntry = {
  name: string;
  source: FakeReferenceSource;
  status: string;
  path?: string;
  description?: string;
  diagnostic?: string;
  hidden?: boolean;
};

function fakeCatalog(reads: Array<{ entries: FakeReferenceEntry[]; diagnostics: string[] }>): ReferenceCatalogReader {
  let index = 0;
  return {
    read: async () => reads[Math.min(index++, reads.length - 1)] ?? { entries: [], diagnostics: [] },
  } as unknown as ReferenceCatalogReader;
}

function fakeSelectionReader(
  entries: FakeReferenceEntry[],
  children: FakeReferenceChild[],
  options: { diagnostics?: string[]; listingError?: string; listedRoots?: string[] } = {},
): ReferenceCatalogReader {
  const listedRoots = options.listedRoots ?? [];
  return {
    read: async () => ({ entries, diagnostics: options.diagnostics ?? [] }),
    listChildren: async (root: string) => {
      listedRoots.push(root);
      if (options.listingError !== undefined) throw new Error(options.listingError);
      return children;
    },
  } as unknown as ReferenceCatalogReader;
}

test("knowledge_search default discovery groups references before wikis", async () => {
  const root = tempRoot();
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "solid.md"),
    `<!-- pi-c2-wiki-page -->\ntopic: solid\npage: 1\ntotalPages: 1\n\n<!-- pi-c2-wiki-page-end -->\n\nSolid reactivity`,
  );
  const catalog = fakeCatalog([
    {
      diagnostics: [],
      entries: [{ name: "hermes-agent", source: { type: "git" }, status: "available" }],
    },
  ]);
  try {
    const result = await executeKnowledgeSearch({} as never, { wikiRoot: root, referenceCatalog: catalog });
    const details = result.details as unknown as {
      mode: string;
      references: { mode: string; aliases: Array<{ alias: string }> };
      wikis: { mode: string; discovery: { topics: Array<{ topic: string }> } };
    };
    assert.equal(details.mode, "discovery");
    assert.equal(details.references.mode, "references");
    assert.deepEqual(details.references.aliases.map((alias) => alias.alias), ["hermes-agent"]);
    assert.equal(details.wikis.mode, "wikis");
    assert.deepEqual(details.wikis.discovery.topics.map((topic) => topic.topic), ["solid"]);
    const rendered = text(result);
    assert.ok(rendered.indexOf("--references--") < rendered.indexOf("--wikis--"));
    assert.ok(rendered.indexOf("hermes-agent") < rendered.indexOf("solid.md"));
    assert.match(rendered, /--references--[\s\S]*hermes-agent[\s\S]*---[\s\S]*--wikis--[\s\S]*solid\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge_search accepts wildcard discovery with an omitted or null type", async () => {
  const catalog = fakeCatalog([{ entries: [], diagnostics: [] }]);
  const omitted = await executeKnowledgeSearch({ query: "*" } as never, { referenceCatalog: catalog, wikiRoot: join(tempRoot(), "missing") });
  assert.equal((omitted.details as unknown as { mode: string }).mode, "discovery");
  const nullable = await executeKnowledgeSearch({ type: null, query: "*" } as never, { referenceCatalog: catalog, wikiRoot: join(tempRoot(), "missing") });
  assert.equal((nullable.details as unknown as { mode: string }).mode, "discovery");
});

test("knowledge_search accepts any query without a type and still groups references before wiki results", async () => {
  const root = tempRoot();
  writeFileSync(
    join(root, "solid.md"),
    formatWikiEntry({ topic: "solid", source: "web_search", queryOrUrl: "solid", format: "markdown", title: "Solid", text: "Solid reactivity" }),
  );
  const catalog = fakeCatalog([{ entries: [], diagnostics: [] }]);
  try {
    const result = await executeKnowledgeSearch({ query: "solid" } as never, { referenceCatalog: catalog, wikiRoot: root });
    assert.equal((result.details as unknown as { mode: string; query: string }).mode, "discovery");
    assert.equal((result.details as unknown as { query: string }).query, "solid");
    assert.match(text(result), /--references--[\s\S]*--wikis--[\s\S]*solid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge_search references wildcard lists non-hidden aliases with safe metadata in stable order", async () => {
  const catalog = fakeCatalog([
    {
      diagnostics: [],
      entries: [
        { name: "zeta", source: { type: "local", path: "/tmp/secret/zeta-path" }, description: "Zeta docs", status: "available" },
        { name: "alpha", source: { type: "git", repository: "owner/repo" }, status: "available" },
        { name: "hiddenOne", source: { type: "local", path: "/tmp/secret/hidden" }, hidden: true, status: "available" },
      ],
    },
  ]);
  const result = await executeKnowledgeSearch({ type: "references", query: "*" }, { referenceCatalog: catalog });
  const details = result.details as unknown as { mode: string; aliases: Array<Record<string, unknown>>; diagnostics?: unknown };
  assert.equal(details.mode, "references");
  assert.deepEqual(details.aliases.map((alias) => alias.alias), ["alpha", "zeta"]);
  assert.deepEqual(details.aliases.map((alias) => alias.type), ["git", "local"]);
  assert.equal(details.aliases[1]?.description, "Zeta docs");
  assert.deepEqual(details.aliases.map((alias) => alias.status), ["available", "available"]);
  assert.equal((details.aliases[0] as Record<string, unknown>).repository, undefined);
  assert.equal((details.aliases[1] as Record<string, unknown>).path, undefined);
  assert.equal((details.aliases[0] as Record<string, unknown>).name, undefined);
  assert.equal((details.aliases[1] as Record<string, unknown>).head, undefined);
  assert.match(text(result), /alpha/);
  assert.match(text(result), /zeta/);
  assert.doesNotMatch(text(result), /hiddenOne/);
  assert.doesNotMatch(text(result), /owner\/repo/);
  assert.doesNotMatch(text(result), /zeta-path|secret/);
});

test("knowledge_search references discovery reads the catalog fresh on every call", async () => {
  const catalog = fakeCatalog([
    { entries: [{ name: "first", source: { type: "local" }, status: "available" }], diagnostics: [] },
    { entries: [{ name: "second", source: { type: "local" }, status: "available" }], diagnostics: [] },
  ]);
  const first = await executeKnowledgeSearch({ type: "references", query: "*" }, { referenceCatalog: catalog });
  const firstAliases = (first.details as unknown as { aliases: Array<{ alias: string }> }).aliases;
  assert.deepEqual(firstAliases.map((alias) => alias.alias), ["first"]);
  const second = await executeKnowledgeSearch({ type: "references", query: "*" }, { referenceCatalog: catalog });
  const secondAliases = (second.details as unknown as { aliases: Array<{ alias: string }> }).aliases;
  assert.deepEqual(secondAliases.map((alias) => alias.alias), ["second"]);
});

test("knowledge_search references discovery surfaces unavailable entries with safe diagnostics", async () => {
  const catalog = fakeCatalog([
    {
      diagnostics: ["Reference 'broken' is unavailable"],
      entries: [
        { name: "ok", source: { type: "local" }, status: "available" },
        { name: "broken", source: { type: "git", repository: "secret-org/token-repo" }, status: "unavailable", diagnostic: "Git reference is unavailable" },      ],
    },
  ]);
  const result = await executeKnowledgeSearch({ type: "references", query: "*" }, { referenceCatalog: catalog });
  const details = result.details as unknown as { aliases: Array<Record<string, unknown>>; diagnostics?: unknown };
  assert.deepEqual(details.aliases.map((alias) => alias.status), ["unavailable", "available"]);
  assert.equal(details.aliases[0]?.diagnostic, "Git reference is unavailable");
  assert.match(text(result), /broken/);
  assert.doesNotMatch(text(result), /secret-org|token-repo/);
});

test("knowledge_search references discovery handles missing configuration safely and never affects wiki mode", async () => {
  const emptyCatalog = fakeCatalog([{ entries: [], diagnostics: [] }]);
  const result = await executeKnowledgeSearch({ type: "references", query: "*" }, { referenceCatalog: emptyCatalog });
  assert.match(text(result), /no configured references/i);
  assert.deepEqual((result.details as unknown as { aliases: unknown }).aliases, []);

  const root = tempRoot();
  writeFileSync(
    join(root, "wiki.md"),
    `<!-- pi-c2-wiki-page -->\ntopic: wiki\npage: 1\ntotalPages: 1\n\n<!-- pi-c2-wiki-page-end -->\n\nbody`,
  );
  try {
    const wiki = await executeKnowledgeSearch({ type: "wikis", query: "*" }, { wikiRoot: root, referenceCatalog: emptyCatalog });
    assert.match(text(wiki), /wiki\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge_search selects a known local reference and returns a deterministic shallow listing", async () => {
  const listedRoots: string[] = [];
  const catalog = fakeSelectionReader(
    [{ name: "docs", source: { type: "local", path: "/tmp/docs" }, description: "Local docs", status: "available", path: "/real/docs" }],
    [
      { name: "zeta.txt", kind: "file" },
      { name: "guides", kind: "directory" },
      { name: "alpha.md", kind: "file" },
    ],
    { listedRoots },
  );
  const result = await executeKnowledgeSearch({ type: "references", alias: "docs" }, { referenceCatalog: catalog });
  const details = result.details as unknown as {
    selection: {
      alias: string;
      type: string;
      description?: string;
      root: string;
      children: Array<{ name: string; kind: string }>;
      handoff: string;
    };
  };
  assert.equal(details.selection.alias, "docs");
  assert.equal(details.selection.type, "local");
  assert.equal(details.selection.description, "Local docs");
  assert.equal(details.selection.root, "/real/docs");
  assert.deepEqual(details.selection.children, [
    { name: "alpha.md", kind: "file" },
    { name: "guides", kind: "directory" },
    { name: "zeta.txt", kind: "file" },
  ]);
  assert.match(details.selection.handoff, /read|grep|find/i);
  assert.deepEqual(listedRoots, ["/real/docs"]);
  assert.match(text(result), /\/real\/docs/);
  assert.match(text(result), /alpha\.md/);
  assert.doesNotMatch(text(result), /nested|content/);
});

test("knowledge_search selects a known Git reference through its materialized root without exposing repository internals", async () => {
  const catalog = fakeSelectionReader(
    [{ name: "opencode", source: { type: "git", repository: "https://user:secret@example.com/acme/opencode.git", branch: "main" }, status: "available", path: "/cache/opencode" }],
    [{ name: "packages", kind: "directory" }],
  );
  const result = await executeKnowledgeSearch({ type: "references", alias: "opencode" }, { referenceCatalog: catalog });
  const details = result.details as unknown as { selection: Record<string, unknown> };
  assert.equal(details.selection.alias, "opencode");
  assert.equal(details.selection.type, "git");
  assert.equal(details.selection.root, "/cache/opencode");
  assert.deepEqual(details.selection.children, [{ name: "packages", kind: "directory" }]);
  assert.equal(details.selection.repository, undefined);
  assert.equal(details.selection.branch, undefined);
  assert.doesNotMatch(text(result), /user:secret|acme\/opencode/);
});

test("knowledge_search permits explicit selection of a hidden alias", async () => {
  const catalog = fakeSelectionReader(
    [{ name: "private", source: { type: "local", path: "/tmp/private" }, hidden: true, status: "available", path: "/real/private" }],
    [],
  );
  const result = await executeKnowledgeSearch({ type: "references", alias: "private" }, { referenceCatalog: catalog });
  const details = result.details as unknown as { selection: { alias: string; hidden?: boolean; root: string } };
  assert.equal(details.selection.alias, "private");
  assert.equal(details.selection.hidden, true);
  assert.equal(details.selection.root, "/real/private");
});

test("knowledge_search returns safe diagnostics for unknown and unavailable reference selections", async () => {
  const unknownCatalog = fakeSelectionReader(
    [{ name: "docs", source: { type: "local", path: "/tmp/docs" }, status: "available", path: "/real/docs" }],
    [],
  );
  const unknown = await executeKnowledgeSearch({ type: "references", alias: "missing" }, { referenceCatalog: unknownCatalog });
  assert.match(text(unknown), /unknown|not found/i);
  assert.equal((unknown.details as unknown as { selection?: unknown }).selection, undefined);
  assert.doesNotMatch(text(unknown), /real\/docs/);

  const unavailableCatalog = fakeSelectionReader(
    [{ name: "broken", source: { type: "git", repository: "https://secret.example/token.git" }, status: "unavailable", diagnostic: "Git reference is unavailable" }],
    [],
  );
  const unavailable = await executeKnowledgeSearch({ type: "references", alias: "broken" }, { referenceCatalog: unavailableCatalog });
  assert.match(text(unavailable), /unavailable/i);
  assert.doesNotMatch(text(unavailable), /secret\.example|token\.git/);
});

test("knowledge_search maps shallow listing failures to safe diagnostics without recursive inspection", async () => {
  const catalog = fakeSelectionReader(
    [{ name: "docs", source: { type: "local", path: "/tmp/docs" }, status: "available", path: "/real/docs" }],
    [],
    { listingError: "EACCES /real/docs/private-content" },
  );
  const result = await executeKnowledgeSearch({ type: "references", alias: "docs" }, { referenceCatalog: catalog });
  assert.match(text(result), /unable|list|access/i);
  assert.doesNotMatch(text(result), /private-content|EACCES/);
  assert.equal((result.details as unknown as { selection?: unknown }).selection, undefined);
});

test("knowledge_search returns a safe diagnostic when a reference alias is missing", async () => {
  const catalog = fakeCatalog([{ entries: [], diagnostics: ["Reference configuration is unavailable"] }]);
  const result = await executeKnowledgeSearch({ type: "references", alias: "docs" }, { referenceCatalog: catalog });
  assert.match(text(result), /not found|configured|available/i);
  assert.doesNotMatch(text(result), /\/tmp|repository|head/);
});

test("knowledge_search traverses previous and next cursors sequentially", async () => {
  const root = tempRoot();
  for (const [file, page, previous, next] of [
    ["cursor.md", 1, "", "cursor.part-002.md"],
    ["cursor.part-002.md", 2, "cursor.md", "cursor.part-003.md"],
    ["cursor.part-003.md", 3, "cursor.part-002.md", ""],
  ] as const) {
    writeFileSync(
      join(root, file),
      `<!-- pi-c2-wiki-page -->\ntopic: cursor\npage: ${page}\ntotalPages: 3\n${previous ? `previous: ${previous}\n` : ""}${next ? `next: ${next}\n` : ""}\n<!-- pi-c2-wiki-page-end -->\n\nPAGE ${page}`,
    );
  }
  try {
    const first = await executeKnowledgeSearch({ type: "wikis", page: "cursor.md" }, { wikiRoot: root });
    const firstDetails = first.details as unknown as { page: { next?: string } };
    assert.equal(firstDetails.page.next, "cursor.part-002.md");
    const second = await executeKnowledgeSearch({ type: "wikis", page: firstDetails.page.next }, { wikiRoot: root });
    const secondDetails = second.details as unknown as { page: { previous?: string; next?: string } };
    assert.equal(secondDetails.page.previous, "cursor.md");
    assert.equal(secondDetails.page.next, "cursor.part-003.md");
    const previous = await executeKnowledgeSearch({ type: "wikis", page: secondDetails.page.previous }, { wikiRoot: root });
    assert.match(text(previous), /PAGE 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge_search returns empty results for missing or out-of-range pages", async () => {
  const root = tempRoot();
  writeFileSync(join(root, "topic.md"), "<!-- pi-c2-wiki-page -->\ntopic: topic\npage: 1\ntotalPages: 1\n<!-- pi-c2-wiki-page-end -->\n\nPAGE");
  try {
    const missing = await executeKnowledgeSearch({ type: "wikis", page: "topic.part-099.md" }, { wikiRoot: root });
    assert.equal(text(missing), "No local wiki matches found.");
    const outOfRange = await executeKnowledgeSearch({ type: "wikis", page: "99.md" }, { wikiRoot: root });
    assert.equal(text(outOfRange), "No local wiki matches found.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge_search retrieves pages written by the paginated writer", async () => {
  const root = tempRoot();
  try {
    await saveWikiEntry({
      root,
      topic: "writer",
      source: "web_search",
      queryOrUrl: "writer",
      format: "markdown",
      title: "Writer",
      text: `${"writer content.\n\n".repeat(100)}END`,
      pageSize: 512,
    });
    const result = await executeKnowledgeSearch({ type: "wikis", page: "writer.part-002.md" }, { wikiRoot: root });
    assert.match(text(result), /<!-- pi-c2-wiki-page -->/);
    assert.match(text(result), /topic: writer/);
    const details = result.details as unknown as { page: { page: number; totalPages: number } };
    assert.equal(details.page.page, 2);
    assert.ok(details.page.totalPages > 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registered knowledge_search accepts the fixed type-discriminated parameter contract", async () => {
  const tool = captureTool();
  const root = tempRoot();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    const result = await tool.execute(
      "call",
      { type: "wikis", page: "typescript.md", maxResults: 20 },
      undefined,
      undefined,
      context,
    );
    assert.equal(text(result), "No local wiki matches found.");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge_search description distinguishes wiki and reference modes and hands off to filesystem tools", () => {
  const tool = captureTool();
  assert.match(tool.description, /type=\"wikis\"/);
  assert.match(tool.description, /type=\"references\"/);
  assert.match(tool.description, /read\/grep\/find inspection/);
  assert.match(tool.description, /query=\"\*\"/);
  assert.match(tool.description, /full saved page/);
  assert.match(tool.description, /complete page or source root/);
  assert.match(tool.description, /never reason from excerpts/);
  assert.match(tool.description, /Only when local results are absent, insufficient, or time-sensitive/i);
  assert.match(tool.description, /candidate URLs/i);
  assert.match(tool.description, /web_fetch.*free/i);
});

test("the tools barrel exposes only the model-facing knowledge_search surface", async () => {
  const barrel = (await import("../src/index.ts")) as unknown as Record<string, unknown>;
  assert.equal(typeof barrel.executeKnowledgeSearch, "function");
  assert.equal(typeof barrel.registerKnowledgeSearchTool, "function");
  assert.equal(barrel.createReferenceCatalog, undefined);
  assert.equal(barrel.listReferenceChildren, undefined);
  assert.equal(barrel.referenceReposDir, undefined);
  assert.equal(barrel.referenceConfigFile, undefined);
  assert.equal(barrel.gitMaterializer, undefined);
});

test("both wiki and reference modes dispatch through the captured registration safely", async () => {
  const tool = captureTool();
  const root = tempRoot();
  const previousTestHome = process.env.PI_C2_TEST_HOME;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_C2_TEST_HOME = root;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const wikiRoot = join(root, "pi-c2", "wikis");
  mkdirSync(wikiRoot, { recursive: true });
  writeFileSync(
    join(wikiRoot, "topic.md"),
    `<!-- pi-c2-wiki-page -->\ntopic: topic\npage: 1\ntotalPages: 1\n\n<!-- pi-c2-wiki-page-end -->\n\nbody`,
  );
  try {
    const wiki = await tool.execute("call", { type: "wikis", query: "*" }, undefined, undefined, context);
    assert.match(text(wiki), /topic\.md/);
    const refs = await tool.execute("call", { type: "references", query: "*" }, undefined, undefined, context);
    assert.match(text(refs), /no configured references/i);
    assert.deepEqual((refs.details as unknown as { aliases?: unknown }).aliases, []);
  } finally {
    if (previousTestHome === undefined) delete process.env.PI_C2_TEST_HOME;
    else process.env.PI_C2_TEST_HOME = previousTestHome;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge_search short-circuits reference research on an aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await executeKnowledgeSearch({ type: "references", query: "*" }, { signal: controller.signal });
  assert.match(text(result), /Error/);
  assert.doesNotMatch(text(result), /no configured references/i);
});

test("knowledge_search rejects mode-inconsistent fields with safe errors", async () => {
  const wikiWithAlias = await executeKnowledgeSearch({ type: "wikis", query: "typescript", alias: "docs" } as never);
  assert.match(text(wikiWithAlias), /Error/);
  const referenceWithTopic = await executeKnowledgeSearch({ type: "references", query: "*", topic: "docs" } as never);
  assert.match(text(referenceWithTopic), /Error/);
});

test("knowledge_search short-circuits wiki research on an aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await executeKnowledgeSearch({ type: "wikis", query: "*" }, { signal: controller.signal });
  assert.match(text(result), /Error/);
  assert.doesNotMatch(text(result), /no local wiki pages/i);
});

test("reference selection excludes node_modules and .git and caps the immediate child listing", async () => {
  const listedRoots: string[] = [];
  const allChildren: FakeReferenceChild[] = [];
  for (let index = 0; index < MAX_REFERENCE_CHILDREN + 50; index++) {
    allChildren.push({ name: `dep-${String(index).padStart(3, "0")}.md`, kind: "file" });
  }
  allChildren.push({ name: "node_modules", kind: "directory" }, { name: ".git", kind: "directory" });
  const catalog = fakeSelectionReader(
    [{ name: "docs", source: { type: "local" }, status: "available", path: "/real/docs" }],
    allChildren,
    { listedRoots },
  );
  const result = await executeKnowledgeSearch({ type: "references", alias: "docs" }, { referenceCatalog: catalog });
  const details = result.details as unknown as {
    selection: { children: Array<{ name: string; kind: string }>; truncated?: boolean; total?: number; excluded?: number };
  };
  assert.equal(details.selection.children.some((child) => child.name === "node_modules"), false);
  assert.equal(details.selection.children.some((child) => child.name === ".git"), false);
  assert.equal(details.selection.children.length, MAX_REFERENCE_CHILDREN);
  assert.equal(details.selection.truncated, true);
  assert.equal(details.selection.total, MAX_REFERENCE_CHILDREN + 50);
  assert.ok(details.selection.excluded === 2);
  assert.doesNotMatch(text(result), /node_modules/);
  assert.doesNotMatch(text(result), /\.git/);
});

test("wiki discovery output stays bounded even when one topic has oversized page metadata", async () => {
  const root = tempRoot();
  const topic = "very-long-topic-".repeat(12).slice(0, 190);
  for (let index = 0; index <= MAX_WIKI_DISCOVERY_PAGES; index++) {
    const file = index === 0 ? `${topic}.md` : `${topic}.part-${String(index).padStart(3, "0")}.md`;
    writeFileSync(
      join(root, file),
      `<!-- pi-c2-wiki-page -->\ntopic: ${topic}\npage: ${index + 1}\ntotalPages: ${MAX_WIKI_DISCOVERY_PAGES + 1}\n\n<!-- pi-c2-wiki-page-end -->`,
    );
  }
  try {
    const result = await executeKnowledgeSearch({ type: "wikis", query: "*" }, { wikiRoot: root });
    assert.ok(Buffer.byteLength(text(result), "utf8") <= MAX_WIKI_DISCOVERY_OUTPUT_BYTES);
    assert.match(text(result), /discovery output truncated|Topic:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wiki discovery output is bounded to the documented byte budget", async () => {
  const root = tempRoot();
  for (let index = 0; index < 60; index++) {
    const file = `topic-${String(index).padStart(3, "0")}.md`;
    writeFileSync(
      join(root, file),
      `<!-- pi-c2-wiki-page -->\ntopic: topic-${String(index).padStart(3, "0")}\npage: 1\ntotalPages: 1\n\n<!-- pi-c2-wiki-page-end -->`,
    );
  }
  try {
    const result = await executeKnowledgeSearch({ type: "wikis", query: "*" }, { wikiRoot: root });
    assert.ok(Buffer.byteLength(text(result), "utf8") <= MAX_WIKI_DISCOVERY_OUTPUT_BYTES);
    assert.match(text(result), /- topic-\d{3}: topic-\d{3}\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wiki discovery caps pages per topic", async () => {
  const root = tempRoot();
  for (let index = 0; index < MAX_WIKI_DISCOVERY_PAGES + 5; index++) {
    const file = index === 0 ? "long.md" : `long.part-${String(index).padStart(3, "0")}.md`;
    writeFileSync(
      join(root, file),
      `<!-- pi-c2-wiki-page -->\ntopic: long\npage: ${String(index + 1).padStart(3, "0")}\ntotalPages: ${MAX_WIKI_DISCOVERY_PAGES + 5}\n\n<!-- pi-c2-wiki-page-end -->`,
    );
  }
  try {
    const result = await executeKnowledgeSearch({ type: "wikis", query: "*" }, { wikiRoot: root });
    const details = result.details as unknown as {
      discovery: { topics: Array<{ topic: string; pages: unknown[]; truncated?: boolean }> };
    };
    const long = details.discovery.topics.find((topic) => topic.topic === "long");
    assert.ok(long);
    assert.equal(long.pages.length, 20);
    assert.equal(long.truncated, undefined);
    assert.equal((long.pages[0] as { file: string }).file, "long.md");
    assert.equal((long.pages.at(-1) as { file: string }).file, "long.part-019.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
