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
import { formatWikiEntry } from "../src/wiki.ts";

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
        queryOrUrl: "https://example.com/typescript",
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

test("llm_wikis_search enforces default, maximum, excerpt, and aggregate output limits", async () => {
  const root = tempRoot();
  const entries = Array.from({ length: 55 }, (_, index) =>
    formatWikiEntry({
      topic: "limits",
      source: "web_search",
      queryOrUrl: `limits ${index}`,
      format: "markdown",
      title: `Limits ${index}`,
      text: `${"limits ".repeat(600)}${index}`,
      timestamp: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    }),
  ).join("");
  writeFileSync(join(root, "limits.md"), entries);
  try {
    const defaultResult = await executeLlmWikisSearch({ query: "limits" }, { wikiRoot: root });
    const defaultDetails = defaultResult.details as { results: Array<Record<string, unknown>> };
    assert.equal(defaultDetails.results.length, 20);
    assert.ok(defaultDetails.results.every((item) => String(item.excerpt).length <= 2048));
    assert.ok(JSON.stringify(defaultResult).length <= 64 * 1024 + 2048);

    const maxResult = await executeLlmWikisSearch({ query: "limits", maxResults: 50 }, { wikiRoot: root });
    const maxDetails = maxResult.details as { results: Array<Record<string, unknown>> };
    assert.equal(maxDetails.results.length, 50);
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
