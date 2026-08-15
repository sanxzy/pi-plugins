import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { executeKnowledgeSearch } from "../src/registrations/knowledge-search.ts";
import { formatWikiEntry } from "../src/wiki.ts";

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
    assert.ok(Number(items[0]?.score) > Number(items[1]?.score));
    assert.ok(Number(items[1]?.score) > Number(items[2]?.score));
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

test("BM25 corpus statistics follow the active topic filter", async () => {
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
    const filtered = await executeKnowledgeSearch({ type: "wikis", query: "needle", topic: "target" }, { wikiRoot });
    const unfiltered = await executeKnowledgeSearch({ type: "wikis", query: "needle" }, { wikiRoot });
    const filteredScore = Number(details(filtered).results[0]?.score);
    const unfilteredScore = Number(details(unfiltered).results[0]?.score);
    assert.ok(filteredScore > 0);
    assert.ok(unfilteredScore > 0);
    assert.notEqual(filteredScore, unfilteredScore);
  } finally {
    rmSync(wikiRoot, { recursive: true, force: true });
  }
});
