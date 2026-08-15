import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { executeWebFetch } from "../src/registrations/web-fetch.ts";
import { executeWebSearch } from "../src/registrations/web-search.ts";
import { executeKnowledgeSearch } from "../src/registrations/knowledge-search.ts";
import { formatWikiEntry, WIKI_ENTRY_END, WIKI_ENTRY_START } from "../src/wiki.ts";

function root(): string {
  return mkdtempSync(join(tmpdir(), "pi-c2-bm25-"));
}

function details(result: Awaited<ReturnType<typeof executeKnowledgeSearch>>): { results: Array<Record<string, unknown>> } {
  return result.details as unknown as { results: Array<Record<string, unknown>> };
}

test("BM25 uses the explicit smoothed IDF formula and weighted title term frequency", async () => {
  const wikiRoot = root();
  writeFileSync(
    join(wikiRoot, "one.md"),
    formatWikiEntry({
      topic: "one",
      source: "web_search",
      queryOrUrl: "source",
      format: "markdown",
      title: "Needle",
      text: "body",
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
  );
  try {
    const result = await executeKnowledgeSearch({ type: "wikis", query: "needle" }, { wikiRoot });
    const item = details(result).results[0];
    assert.ok(item);
    // N=1, df=1, weighted length=12, tf=3, k1=1.2, b=0.75:
    // ln(1 + (1 - 1 + .5) / (1 + .5)) * (3 * 2.2) / (3 + 1.2) = 0.452071828...
    assert.equal(item.score, 0.452072);
  } finally {
    rmSync(wikiRoot, { recursive: true, force: true });
  }
});

test("BM25 includes title, metadata, and body-only matches with field priority", async () => {
  const wikiRoot = root();
  const entry = (title: string, queryOrUrl: string, text: string, source: "web_search" | "web_fetch") =>
    formatWikiEntry({
      topic: "fields",
      source,
      queryOrUrl,
      format: "markdown",
      title,
      text,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
  writeFileSync(
    join(wikiRoot, "fields.md"),
    entry("Needle", "metadata", "body", "web_search") +
      entry("title", "Needle", "body", "web_fetch") +
      entry("title", "metadata", "Needle", "web_search"),
  );
  try {
    const result = await executeKnowledgeSearch({ type: "wikis", query: "needle" }, { wikiRoot });
    const items = details(result).results;
    assert.equal(items.length, 3);
    assert.ok(items.every((item) => Number(item.score) > 0));
    assert.deepEqual(items.map((item) => Number(item.score) > 0), [true, true, true]);
    assert.deepEqual(items.map((item) => item.score), [0.209835, 0.183606, 0.133531]);
  } finally {
    rmSync(wikiRoot, { recursive: true, force: true });
  }
});

test("BM25 normalizes accents and camelCase, removes fixed stopwords, and stays exact-only", async () => {
  const wikiRoot = root();
  writeFileSync(
    join(wikiRoot, "normalized.md"),
    formatWikiEntry({
      topic: "normalized",
      source: "web_search",
      queryOrUrl: "normalization",
      format: "markdown",
      title: "Café createSignal",
      text: "exact technical token",
    }),
  );
  try {
    const accent = await executeKnowledgeSearch({ type: "wikis", query: "cafe" }, { wikiRoot });
    assert.equal(details(accent).results.length, 1);
    const camel = await executeKnowledgeSearch({ type: "wikis", query: "signal" }, { wikiRoot });
    assert.equal(details(camel).results.length, 1);
    const stopwords = await executeKnowledgeSearch({ type: "wikis", query: "how does the and of" }, { wikiRoot });
    const stopwordText = stopwords.content[0]?.type === "text" ? stopwords.content[0].text : undefined;
    assert.equal(stopwordText, "No local wiki matches found.");
    const typo = await executeKnowledgeSearch({ type: "wikis", query: "sigmal" }, { wikiRoot });
    assert.equal(details(typo).results.length, 0);
    const stem = await executeKnowledgeSearch({ type: "wikis", query: "technicals" }, { wikiRoot });
    assert.equal(details(stem).results.length, 0);
  } finally {
    rmSync(wikiRoot, { recursive: true, force: true });
  }
});

test("BM25 applies weighted length, saturation, and excludes timestamp/title metadata", async () => {
  const wikiRoot = root();
  writeFileSync(
    join(wikiRoot, "length.md"),
    formatWikiEntry({
      topic: "length",
      source: "web_search",
      queryOrUrl: "metadata",
      format: "markdown",
      title: "Title",
      text: "needle needle",
      timestamp: "2026-01-01T00:00:00.000Z",
    }) +
      formatWikiEntry({
        topic: "length",
        source: "web_fetch",
        queryOrUrl: "other",
        format: "markdown",
        title: "Other",
        text: `needle ${"padding ".repeat(30)}`,
        timestamp: "2026-01-02T00:00:00.000Z",
      }),
  );
  writeFileSync(
    join(wikiRoot, "excluded.md"),
    [
      WIKI_ENTRY_START,
      "## Visible heading",
      "timestamp: 2026-01-03T00:00:00.000Z",
      "source: web_search",
      "query: ordinary",
      "format: markdown",
      "title: persistedUniqueMarker",
      "",
      "body without the search term",
      WIKI_ENTRY_END,
      "",
    ].join("\n"),
  );
  try {
    const repeated = await executeKnowledgeSearch({ type: "wikis", query: "needle" }, { wikiRoot });
    const repeatedItems = details(repeated).results;
    assert.equal(repeatedItems.length, 2);
    assert.ok(Number(repeatedItems[0]?.score) > Number(repeatedItems[1]?.score));

    const timestampOnly = await executeKnowledgeSearch({ type: "wikis", query: "2026" }, { wikiRoot });
    assert.equal(details(timestampOnly).results.length, 0);
    const duplicateTitleOnly = await executeKnowledgeSearch({ type: "wikis", query: "persistedUniqueMarker" }, { wikiRoot });
    assert.equal(details(duplicateTitleOnly).results.length, 0);
  } finally {
    rmSync(wikiRoot, { recursive: true, force: true });
  }
});

test("BM25 excludes unreadable markdown files from corpus statistics", async () => {
  const wikiRoot = root();
  writeFileSync(join(wikiRoot, "readable.md"), formatWikiEntry({
    topic: "readable",
    source: "web_search",
    queryOrUrl: "readable",
    format: "markdown",
    title: "Needle",
    text: "body",
  }));
  mkdirSync(join(wikiRoot, "unreadable.md"));
  try {
    const result = await executeKnowledgeSearch({ type: "wikis", query: "needle" }, { wikiRoot });
    assert.equal(details(result).results.length, 1);
    assert.equal(details(result).results[0]?.file, "readable.md");
  } finally {
    rmSync(wikiRoot, { recursive: true, force: true });
  }
});

test("BM25 deduplicates query terms and splits PascalCase punctuation exactly", async () => {
  const wikiRoot = root();
  writeFileSync(join(wikiRoot, "tokens.md"), formatWikiEntry({
    topic: "tokens",
    source: "web_search",
    queryOrUrl: "source",
    format: "markdown",
    title: "PascalCase",
    text: "needle-value",
  }));
  try {
    const single = await executeKnowledgeSearch({ type: "wikis", query: "needle" }, { wikiRoot });
    const repeated = await executeKnowledgeSearch({ type: "wikis", query: "needle needle" }, { wikiRoot });
    assert.equal(details(single).results[0]?.score, details(repeated).results[0]?.score);
    const pascal = await executeKnowledgeSearch({ type: "wikis", query: "pascal case" }, { wikiRoot });
    assert.equal(details(pascal).results.length, 1);
    const punctuation = await executeKnowledgeSearch({ type: "wikis", query: "needle/value" }, { wikiRoot });
    assert.equal(details(punctuation).results.length, 1);
  } finally {
    rmSync(wikiRoot, { recursive: true, force: true });
  }
});

test("BM25 orders by full precision before public score rounding", async () => {
  const wikiRoot = root();
  writeFileSync(join(wikiRoot, "z-short.md"), formatWikiEntry({
    topic: "z-short",
    source: "web_search",
    queryOrUrl: "source",
    format: "markdown",
    title: "Short",
    text: `needle ${"x ".repeat(1_000_000)}`,
    timestamp: "2026-01-01T00:00:00.000Z",
  }));
  writeFileSync(join(wikiRoot, "a-long.md"), formatWikiEntry({
    topic: "a-long",
    source: "web_search",
    queryOrUrl: "source",
    format: "markdown",
    title: "Long",
    text: `needle ${"x ".repeat(1_000_001)}`,
    timestamp: "2026-01-01T00:00:00.000Z",
  }));
  try {
    const result = await executeKnowledgeSearch({ type: "wikis", query: "needle" }, { wikiRoot });
    const items = details(result).results;
    assert.equal(items.length, 2);
    assert.equal(items[0]?.file, "z-short.md");
    assert.equal(items[1]?.file, "a-long.md");
    assert.equal(items[0]?.score, items[1]?.score);
  } finally {
    rmSync(wikiRoot, { recursive: true, force: true });
  }
});

test("web_search and web_fetch persistence feeds the same local BM25 corpus", async () => {
  const wikiRoot = root();
  const originalFetch = globalThis.fetch;
  let request = 0;
  globalThis.fetch = (async () => {
    request += 1;
    if (request === 1) {
      return new Response(JSON.stringify({ result: { content: [{ text: "zqvsearchbody" }] } }), { status: 200 });
    }
    return new Response("zqvfetchbody", { headers: { "content-type": "text/plain" } });
  }) as typeof globalThis.fetch;
  try {
    await executeWebSearch({ query: "zqvsearchmeta" }, undefined, undefined, {
      wikiRoot,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    await executeWebFetch({ url: "https://example.com/zqvfetchmeta" }, undefined, {
      wikiRoot,
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });
    const searchMatch = await executeKnowledgeSearch({ type: "wikis", query: "zqvsearchbody" }, { wikiRoot });
    const fetchMatch = await executeKnowledgeSearch({ type: "wikis", query: "zqvfetchbody" }, { wikiRoot });
    assert.equal(details(searchMatch).results.length, 1);
    assert.equal(details(searchMatch).results[0]?.source, "web_search");
    assert.equal(details(fetchMatch).results.length, 1);
    assert.equal(details(fetchMatch).results[0]?.source, "web_fetch");
    const metadataMatch = await executeKnowledgeSearch({ type: "wikis", query: "zqvfetchmeta" }, { wikiRoot });
    assert.equal(details(metadataMatch).results.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(wikiRoot, { recursive: true, force: true });
  }
});

test("BM25 corpus statistics include all matching wiki pages", async () => {
  const wikiRoot = root();
  writeFileSync(
    join(wikiRoot, "target.md"),
    formatWikiEntry({
      topic: "target",
      source: "web_search",
      queryOrUrl: "target",
      format: "markdown",
      title: "Needle",
      text: "body",
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
  );
  writeFileSync(
    join(wikiRoot, "other.md"),
    formatWikiEntry({
      topic: "other",
      source: "web_fetch",
      queryOrUrl: "other",
      format: "markdown",
      title: "Other",
      text: "long unrelated body content padding padding padding padding padding",
      timestamp: "2026-01-02T00:00:00.000Z",
    }),
  );
  try {
    const result = await executeKnowledgeSearch({ type: "wikis", query: "needle" }, { wikiRoot });
    const score = Number(details(result).results[0]?.score);
    assert.ok(score > 0);
    assert.equal(details(result).results[0]?.file, "target.md");
  } finally {
    rmSync(wikiRoot, { recursive: true, force: true });
  }
});
