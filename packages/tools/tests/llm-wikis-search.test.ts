import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  executeLlmWikisSearch,
  registerLlmWikisSearchTool,
  type ReferenceCatalogReader,
} from "../src/registrations/llm-wikis-search.ts";
import { formatWikiEntry, saveWikiEntry } from "../src/wiki.ts";

type Tool = {
  name: string;
  description: string;
  parameters: { type?: string; properties?: Record<string, { type?: string; anyOf?: unknown[] }> };
  execute: (...args: unknown[]) => Promise<{
    content: Array<{ type: string; text?: string }>;
    details: Record<string, unknown>;
  }>;
};

const context = {} as ExtensionContext;

function captureTool(): Tool {
  let registered: Tool | undefined;
  registerLlmWikisSearchTool({
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
  return mkdtempSync(join(tmpdir(), "pi-code-wikis-search-"));
}

test("llm_wikis_search is registered with an explicit type discriminator and a local-first description", () => {
  const tool = captureTool();
  assert.equal(tool.name, "llm_wikis_search");
  const props = tool.parameters.properties ?? {};
  const typeField = props.type;
  assert.ok(Array.isArray(typeField?.anyOf));
  const literals = (typeField?.anyOf ?? []).map((variant) => (variant as { const?: string }).const);
  assert.deepEqual(literals, ["wikis", "references"]);
  assert.match(tool.description, /wikis/i);
  assert.match(tool.description, /references/i);
  assert.match(tool.description, /local/i);
  assert.match(tool.description, /web_search/);
  assert.match(tool.description, /web_fetch/);
  assert.match(tool.description, /broad-to-specific/i);
  assert.match(tool.description, /topic\/page/);
  assert.match(tool.description, /local cache only/i);
  assert.match(tool.description, /time-sensitive/i);
});

test("llm_wikis_search routes an unsupported type to a safe error", async () => {
  const result = await executeLlmWikisSearch({ type: "invalid" as never });
  assert.match(text(result), /Error/);
});

test("llm_wikis_search returns an empty structured result for an absent wiki directory", async () => {
  const root = join(tempRoot(), "missing");
  try {
    const result = await executeLlmWikisSearch({ type: "wikis", query: "typescript" }, { wikiRoot: root });
    assert.equal(text(result), "No local wiki matches found.");
    assert.deepEqual(result.details, { mode: "wikis", query: "typescript", results: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("llm_wikis_search returns an empty structured result for an empty wiki directory", async () => {
  const root = tempRoot();
  mkdirSync(root, { recursive: true });
  try {
    const result = await executeLlmWikisSearch(
      { type: "wikis", query: "typescript", topic: "TypeScript Notes", page: "001", maxResults: 50 },
      { wikiRoot: root },
    );
    assert.equal(text(result), "No local wiki matches found.");
    assert.deepEqual(result.details, { mode: "wikis", query: "typescript", topic: "TypeScript Notes", results: [] });
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("llm_wikis_search returns deterministically ranked excerpts with scores and metadata", async () => {
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
    const result = await executeLlmWikisSearch({ type: "wikis", query: "typescript" }, { wikiRoot: root });
    const details = result.details as unknown as unknown as { results: Array<Record<string, unknown>> };
    assert.equal(details.results.length, 2);
    assert.equal(details.results[0]?.score, 3);
    assert.equal(details.results[1]?.score, 1);
    assert.equal(details.results[0]?.file, "typescript-notes.md");
    assert.equal(details.results[0]?.source, "web_search");
    assert.equal(typeof details.results[0]?.excerpt, "string");
    assert.match(text(result), /typescript-notes\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("llm_wikis_search accepts natural-language topic filters and searches continuation filenames", async () => {
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
    formatWikiEntry({ topic: "vue-notes", source: "web_search", queryOrUrl: "vue", format: "markdown", title: "Vue", text: "hooks", timestamp: "2026-01-03T00:00:00.000Z" }),
  );
  try {
    const result = await executeLlmWikisSearch({ type: "wikis", query: "hooks", topic: "React Notes" }, { wikiRoot: root });
    const details = result.details as unknown as unknown as { results: Array<Record<string, unknown>> };
    assert.equal(details.results.length, 2);
    assert.deepEqual(details.results.map((item) => item.file), ["react-notes.part-002.md", "react-notes.md"]);
    assert.equal(details.results.every((item) => String(item.file).startsWith("react-notes")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("llm_wikis_search defaults to 20 results and caps at the 50 maximum", async () => {
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
    const defaultResult = await executeLlmWikisSearch({ type: "wikis", query: "limits" }, { wikiRoot: root });
    const defaultDetails = defaultResult.details as unknown as { results: Array<Record<string, unknown>> };
    assert.equal(defaultDetails.results.length, 20);

    const maxResult = await executeLlmWikisSearch({ type: "wikis", query: "limits", maxResults: 50 }, { wikiRoot: root });
    const maxDetails = maxResult.details as unknown as { results: Array<Record<string, unknown>> };
    assert.equal(maxDetails.results.length, 50);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("llm_wikis_search bounds each excerpt to approximately 2 KB and the aggregate output", async () => {
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
    const result = await executeLlmWikisSearch({ type: "wikis", query: "typescript" }, { wikiRoot: root });
    const details = result.details as unknown as unknown as { results: Array<Record<string, unknown>> };
    assert.equal(details.results.length, 1);
    assert.ok(String(details.results[0]?.excerpt).length <= 2048);
    assert.ok(text(result).length <= 64 * 1024);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("llm_wikis_search breaks equal scores by newest timestamp then filename", async () => {
  const root = tempRoot();
  const entry = (title: string, timestamp: string) =>
    formatWikiEntry({ topic: "ties", source: "web_search", queryOrUrl: "ties", format: "markdown", title, text: "ties", timestamp });
  writeFileSync(join(root, "zeta.md"), entry("Zeta", "2026-01-02T00:00:00.000Z"));
  writeFileSync(join(root, "alpha.md"), entry("Alpha", "2026-01-02T00:00:00.000Z"));
  try {
    const result = await executeLlmWikisSearch({ type: "wikis", query: "ties" }, { wikiRoot: root });
    const details = result.details as unknown as unknown as { results: Array<Record<string, unknown>> };
    assert.deepEqual(details.results.map((item) => item.file), ["alpha.md", "zeta.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("llm_wikis_search retrieves a complete page with metadata without requiring a query", async () => {
  const root = tempRoot();
  writeFileSync(
    join(root, "react.md"),
    `<!-- pi-code-wiki-page -->\ntopic: react\npage: 1\ntotalPages: 2\nnext: react.part-002.md\n\n[Next](./react.part-002.md)\n<!-- pi-code-wiki-page-end -->\n\nFULL PAGE ONE\n${formatWikiEntry({ topic: "react", source: "web_search", queryOrUrl: "react", format: "markdown", title: "React", text: "one", timestamp: "2026-01-01T00:00:00.000Z" })}`,
  );
  writeFileSync(
    join(root, "react.part-002.md"),
    `<!-- pi-code-wiki-page -->\ntopic: react\npage: 2\ntotalPages: 2\nprevious: react.md\n\n[Previous](./react.md)\n<!-- pi-code-wiki-page-end -->\n\nFULL PAGE TWO`,
  );
  try {
    const result = await executeLlmWikisSearch({ type: "wikis", topic: "React", page: "2" }, { wikiRoot: root });
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

test("llm_wikis_search wildcard discovers topics and continuation pages without matching content", async () => {
  const root = tempRoot();
  writeFileSync(
    join(root, "alpha.md"),
    `<!-- pi-code-wiki-page -->\ntopic: alpha\npage: 1\ntotalPages: 2\nnext: alpha.part-002.md\n\n<!-- pi-code-wiki-page-end -->\n\nsecret-token-never-returned`,
  );
  writeFileSync(
    join(root, "alpha.part-002.md"),
    `<!-- pi-code-wiki-page -->\ntopic: alpha\npage: 2\ntotalPages: 2\nprevious: alpha.md\n\n<!-- pi-code-wiki-page-end -->\n\nmore-secret-content`,
  );
  writeFileSync(
    join(root, "beta.md"),
    `<!-- pi-code-wiki-page -->\ntopic: beta\npage: 1\ntotalPages: 1\n\n<!-- pi-code-wiki-page-end -->\n\nbody without a search token`,
  );
  try {
    const result = await executeLlmWikisSearch({ type: "wikis", query: "*" }, { wikiRoot: root });
    const details = result.details as unknown as { discovery: { topics: Array<{ topic: string; pages: Array<Record<string, unknown>> }> } };
    assert.deepEqual(details.discovery.topics.map((topic) => topic.topic), ["alpha", "beta"]);
    assert.deepEqual(details.discovery.topics[0]?.pages.map((page) => page.file), ["alpha.md", "alpha.part-002.md"]);
    assert.deepEqual(details.discovery.topics[0]?.pages[0], {
      file: "alpha.md",
      page: 1,
      totalPages: 2,
      next: "alpha.part-002.md",
    });
    assert.deepEqual(details.discovery.topics[0]?.pages[1], {
      file: "alpha.part-002.md",
      page: 2,
      totalPages: 2,
      previous: "alpha.md",
    });
    assert.match(text(result), /alpha\.part-002\.md/);
    assert.doesNotMatch(text(result), /secret-token|more-secret-content/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("llm_wikis_search wildcard applies a topic filter without tokenizing or ranking pages", async () => {
  const root = tempRoot();
  writeFileSync(
    join(root, "react.md"),
    `<!-- pi-code-wiki-page -->\ntopic: react\npage: 1\ntotalPages: 1\n\n<!-- pi-code-wiki-page-end -->\n\nno matching query terms`,
  );
  writeFileSync(
    join(root, "vue.md"),
    `<!-- pi-code-wiki-page -->\ntopic: vue\npage: 1\ntotalPages: 1\n\n<!-- pi-code-wiki-page-end -->\n\nno matching query terms`,
  );
  try {
    const result = await executeLlmWikisSearch({ type: "wikis", query: "*", topic: "React" }, { wikiRoot: root });
    const details = result.details as unknown as { discovery: { topics: Array<{ topic: string }> } };
    assert.deepEqual(details.discovery.topics.map((topic) => topic.topic), ["react"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("llm_wikis_search wildcard has deterministic bounded discovery output", async () => {
  const root = tempRoot();
  for (let index = 55; index >= 1; index--) {
    writeFileSync(
      join(root, `topic-${String(index).padStart(2, "0")}.md`),
      `<!-- pi-code-wiki-page -->\ntopic: topic-${String(index).padStart(2, "0")}\npage: 1\ntotalPages: 1\n\n<!-- pi-code-wiki-page-end -->`,
    );
  }
  try {
    const result = await executeLlmWikisSearch({ type: "wikis", query: "*", maxResults: 20 }, { wikiRoot: root });
    const details = result.details as unknown as { discovery: { topics: Array<{ topic: string }> } };
    assert.equal(details.discovery.topics.length, 20);
    assert.deepEqual(details.discovery.topics.map((topic) => topic.topic), Array.from({ length: 20 }, (_, index) => `topic-${String(index + 1).padStart(2, "0")}`));
    assert.ok(text(result).length <= 64 * 1024);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("llm_wikis_search wildcard handles absent, empty, malformed, and unreadable roots safely", async () => {
  const missing = await executeLlmWikisSearch({ type: "wikis", query: "*" }, { wikiRoot: join(tempRoot(), "missing") });
  assert.equal(text(missing), "No local wiki pages found.");
  assert.deepEqual((missing.details as unknown as { discovery: unknown }).discovery, { topics: [] });

  const emptyRoot = tempRoot();
  try {
    const empty = await executeLlmWikisSearch({ type: "wikis", query: "*" }, { wikiRoot: emptyRoot });
    assert.equal(text(empty), "No local wiki pages found.");
    assert.deepEqual((empty.details as unknown as { discovery: unknown }).discovery, { topics: [] });
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true });
  }

  const malformedRoot = tempRoot();
  writeFileSync(join(malformedRoot, "malformed.md"), "not a wiki page");
  try {
    const malformed = await executeLlmWikisSearch({ type: "wikis", query: "*" }, { wikiRoot: malformedRoot });
    assert.equal(text(malformed), "No local wiki pages found.");
    assert.deepEqual((malformed.details as unknown as { discovery: unknown }).discovery, { topics: [] });
  } finally {
    rmSync(malformedRoot, { recursive: true, force: true });
  }

  const fileRoot = join(tempRoot(), "not-a-directory.md");
  writeFileSync(fileRoot, "not a directory");
  const unreadable = await executeLlmWikisSearch({ type: "wikis", query: "*" }, { wikiRoot: fileRoot });
  assert.equal(text(unreadable), "No local wiki pages found.");
  assert.deepEqual((unreadable.details as unknown as { discovery: unknown }).discovery, { topics: [] });
});

type FakeReferenceSource =
  | { type: "local"; description?: string; hidden?: boolean; path?: string }
  | { type: "git"; description?: string; hidden?: boolean; repository?: string };

type FakeReferenceEntry = { name: string; source: FakeReferenceSource; status: string; description?: string; diagnostic?: string; hidden?: boolean };

function fakeCatalog(reads: Array<{ entries: FakeReferenceEntry[]; diagnostics: string[] }>): ReferenceCatalogReader {
  let index = 0;
  return {
    read: async () => reads[Math.min(index++, reads.length - 1)] ?? { entries: [], diagnostics: [] },
  } as unknown as ReferenceCatalogReader;
}

test("llm_wikis_search references wildcard lists non-hidden aliases with safe metadata in stable order", async () => {
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
  const result = await executeLlmWikisSearch({ type: "references", query: "*" }, { referenceCatalog: catalog });
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

test("llm_wikis_search references discovery reads the catalog fresh on every call", async () => {
  const catalog = fakeCatalog([
    { entries: [{ name: "first", source: { type: "local" }, status: "available" }], diagnostics: [] },
    { entries: [{ name: "second", source: { type: "local" }, status: "available" }], diagnostics: [] },
  ]);
  const first = await executeLlmWikisSearch({ type: "references", query: "*" }, { referenceCatalog: catalog });
  const firstAliases = (first.details as unknown as { aliases: Array<{ alias: string }> }).aliases;
  assert.deepEqual(firstAliases.map((alias) => alias.alias), ["first"]);
  const second = await executeLlmWikisSearch({ type: "references", query: "*" }, { referenceCatalog: catalog });
  const secondAliases = (second.details as unknown as { aliases: Array<{ alias: string }> }).aliases;
  assert.deepEqual(secondAliases.map((alias) => alias.alias), ["second"]);
});

test("llm_wikis_search references discovery surfaces unavailable entries with safe diagnostics", async () => {
  const catalog = fakeCatalog([
    {
      diagnostics: ["Reference 'broken' is unavailable"],
      entries: [
        { name: "ok", source: { type: "local" }, status: "available" },
        { name: "broken", source: { type: "git", repository: "secret-org/token-repo" }, status: "unavailable", diagnostic: "Git reference is unavailable" },      ],
    },
  ]);
  const result = await executeLlmWikisSearch({ type: "references", query: "*" }, { referenceCatalog: catalog });
  const details = result.details as unknown as { aliases: Array<Record<string, unknown>>; diagnostics?: unknown };
  assert.deepEqual(details.aliases.map((alias) => alias.status), ["unavailable", "available"]);
  assert.equal(details.aliases[0]?.diagnostic, "Git reference is unavailable");
  assert.match(text(result), /broken/);
  assert.doesNotMatch(text(result), /secret-org|token-repo/);
});

test("llm_wikis_search references discovery handles missing configuration safely and never affects wiki mode", async () => {
  const emptyCatalog = fakeCatalog([{ entries: [], diagnostics: [] }]);
  const result = await executeLlmWikisSearch({ type: "references", query: "*" }, { referenceCatalog: emptyCatalog });
  assert.match(text(result), /no configured references/i);
  assert.deepEqual((result.details as unknown as { aliases: unknown }).aliases, []);

  const root = tempRoot();
  writeFileSync(
    join(root, "wiki.md"),
    `<!-- pi-code-wiki-page -->\ntopic: wiki\npage: 1\ntotalPages: 1\n\n<!-- pi-code-wiki-page-end -->\n\nbody`, 
  );
  try {
    const wiki = await executeLlmWikisSearch({ type: "wikis", query: "*" }, { wikiRoot: root, referenceCatalog: emptyCatalog });
    assert.match(text(wiki), /wiki\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("llm_wikis_search traverses previous and next cursors sequentially", async () => {
  const root = tempRoot();
  for (const [file, page, previous, next] of [
    ["cursor.md", 1, "", "cursor.part-002.md"],
    ["cursor.part-002.md", 2, "cursor.md", "cursor.part-003.md"],
    ["cursor.part-003.md", 3, "cursor.part-002.md", ""],
  ] as const) {
    writeFileSync(
      join(root, file),
      `<!-- pi-code-wiki-page -->\ntopic: cursor\npage: ${page}\ntotalPages: 3\n${previous ? `previous: ${previous}\n` : ""}${next ? `next: ${next}\n` : ""}\n<!-- pi-code-wiki-page-end -->\n\nPAGE ${page}`,
    );
  }
  try {
    const first = await executeLlmWikisSearch({ type: "wikis", topic: "cursor", page: "1" }, { wikiRoot: root });
    const firstDetails = first.details as unknown as { page: { next?: string } };
    assert.equal(firstDetails.page.next, "cursor.part-002.md");
    const second = await executeLlmWikisSearch({ type: "wikis", topic: "cursor", page: firstDetails.page.next }, { wikiRoot: root });
    const secondDetails = second.details as unknown as { page: { previous?: string; next?: string } };
    assert.equal(secondDetails.page.previous, "cursor.md");
    assert.equal(secondDetails.page.next, "cursor.part-003.md");
    const previous = await executeLlmWikisSearch({ type: "wikis", topic: "cursor", page: secondDetails.page.previous }, { wikiRoot: root });
    assert.match(text(previous), /PAGE 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("llm_wikis_search returns empty results for missing or out-of-range pages", async () => {
  const root = tempRoot();
  writeFileSync(join(root, "topic.md"), "<!-- pi-code-wiki-page -->\ntopic: topic\npage: 1\ntotalPages: 1\n<!-- pi-code-wiki-page-end -->\n\nPAGE");
  try {
    const missing = await executeLlmWikisSearch({ type: "wikis", topic: "topic", page: "topic.part-099.md" }, { wikiRoot: root });
    assert.equal(text(missing), "No local wiki matches found.");
    const outOfRange = await executeLlmWikisSearch({ type: "wikis", topic: "topic", page: "99" }, { wikiRoot: root });
    assert.equal(text(outOfRange), "No local wiki matches found.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("llm_wikis_search retrieves pages written by the paginated writer", async () => {
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
    const result = await executeLlmWikisSearch({ type: "wikis", topic: "writer", page: "2" }, { wikiRoot: root });
    assert.match(text(result), /<!-- pi-code-wiki-page -->/);
    assert.match(text(result), /topic: writer/);
    const details = result.details as unknown as { page: { page: number; totalPages: number } };
    assert.equal(details.page.page, 2);
    assert.ok(details.page.totalPages > 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registered llm_wikis_search accepts the fixed type-discriminated parameter contract", async () => {
  const tool = captureTool();
  const root = tempRoot();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    const result = await tool.execute(
      "call",
      { type: "wikis", query: "typescript", topic: "typescript", page: "001", maxResults: 20 },
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
