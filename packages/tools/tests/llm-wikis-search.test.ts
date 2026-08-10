import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  executeLlmWikisSearch,
  registerLlmWikisSearchTool,
} from "../src/registrations/llm-wikis-search.ts";
import { formatWikiEntry, saveWikiEntry } from "../src/wiki.ts";

type Tool = {
  name: string;
  description: string;
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

test("llm_wikis_search is registered with the local-first fallback description", () => {
  const tool = captureTool();
  assert.equal(tool.name, "llm_wikis_search");
  assert.match(tool.description, /local/i);
  assert.match(tool.description, /web_search/);
  assert.match(tool.description, /web_fetch/);
});

test("llm_wikis_search returns an empty structured result for an absent wiki directory", async () => {
  const root = join(tempRoot(), "missing");
  try {
    const result = await executeLlmWikisSearch({ query: "typescript" }, { wikiRoot: root });
    assert.equal(text(result), "No local wiki matches found.");
    assert.deepEqual(result.details, { query: "typescript", results: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("llm_wikis_search returns an empty structured result for an empty wiki directory", async () => {
  const root = tempRoot();
  mkdirSync(root, { recursive: true });
  try {
    const result = await executeLlmWikisSearch(
      { query: "typescript", topic: "TypeScript Notes", page: "001", maxResults: 50 },
      { wikiRoot: root },
    );
    assert.equal(text(result), "No local wiki matches found.");
    assert.deepEqual(result.details, { query: "typescript", topic: "TypeScript Notes", results: [] });
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
    const result = await executeLlmWikisSearch({ query: "typescript" }, { wikiRoot: root });
    const details = result.details as { results: Array<Record<string, unknown>> };
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
    const result = await executeLlmWikisSearch({ query: "hooks", topic: "React Notes" }, { wikiRoot: root });
    const details = result.details as { results: Array<Record<string, unknown>> };
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
    const defaultResult = await executeLlmWikisSearch({ query: "limits" }, { wikiRoot: root });
    const defaultDetails = defaultResult.details as { results: Array<Record<string, unknown>> };
    assert.equal(defaultDetails.results.length, 20);

    const maxResult = await executeLlmWikisSearch({ query: "limits", maxResults: 50 }, { wikiRoot: root });
    const maxDetails = maxResult.details as { results: Array<Record<string, unknown>> };
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
    const result = await executeLlmWikisSearch({ query: "typescript" }, { wikiRoot: root });
    const details = result.details as { results: Array<Record<string, unknown>> };
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
    const result = await executeLlmWikisSearch({ query: "ties" }, { wikiRoot: root });
    const details = result.details as { results: Array<Record<string, unknown>> };
    assert.deepEqual(details.results.map((item) => item.file), ["alpha.md", "zeta.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("llm_wikis_search retrieves a complete page with metadata", async () => {
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
    const result = await executeLlmWikisSearch({ query: "ignored", topic: "React", page: "2" }, { wikiRoot: root });
    assert.equal(text(result), readFileSync(join(root, "react.part-002.md"), "utf8"));
    const details = result.details as unknown as Record<string, unknown>;
    assert.deepEqual(details.page, {
      file: "react.part-002.md",
      topic: "react",
      page: 2,
      totalPages: 2,
      previous: "react.md",
    });
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
    const first = await executeLlmWikisSearch({ query: "", topic: "cursor", page: "1" }, { wikiRoot: root });
    const firstDetails = first.details as { page: { next?: string } };
    assert.equal(firstDetails.page.next, "cursor.part-002.md");
    const second = await executeLlmWikisSearch({ query: "", topic: "cursor", page: firstDetails.page.next }, { wikiRoot: root });
    const secondDetails = second.details as { page: { previous?: string; next?: string } };
    assert.equal(secondDetails.page.previous, "cursor.md");
    assert.equal(secondDetails.page.next, "cursor.part-003.md");
    const previous = await executeLlmWikisSearch({ query: "", topic: "cursor", page: secondDetails.page.previous }, { wikiRoot: root });
    assert.match(text(previous), /PAGE 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("llm_wikis_search returns empty results for missing or out-of-range pages", async () => {
  const root = tempRoot();
  writeFileSync(join(root, "topic.md"), "<!-- pi-code-wiki-page -->\ntopic: topic\npage: 1\ntotalPages: 1\n<!-- pi-code-wiki-page-end -->\n\nPAGE");
  try {
    const missing = await executeLlmWikisSearch({ query: "x", topic: "topic", page: "topic.part-099.md" }, { wikiRoot: root });
    assert.equal(text(missing), "No local wiki matches found.");
    const outOfRange = await executeLlmWikisSearch({ query: "x", topic: "topic", page: "99" }, { wikiRoot: root });
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
    const result = await executeLlmWikisSearch({ query: "ignored", topic: "writer", page: "2" }, { wikiRoot: root });
    assert.match(text(result), /<!-- pi-code-wiki-page -->/);
    assert.match(text(result), /topic: writer/);
    const details = result.details as { page: { page: number; totalPages: number } };
    assert.equal(details.page.page, 2);
    assert.ok(details.page.totalPages > 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registered llm_wikis_search accepts the fixed parameter contract", async () => {
  const tool = captureTool();
  const root = tempRoot();
  try {
    const result = await tool.execute(
      "call",
      { query: "typescript", topic: "typescript", page: "001", maxResults: 20 },
      undefined,
      undefined,
      context,
    );
    assert.equal(text(result), "No local wiki matches found.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
