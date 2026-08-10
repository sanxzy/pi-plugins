import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  formatWikiEntry,
  saveWikiEntry,
  slugify,
  slugifyQuery,
  slugifyUrl,
  WIKI_ENTRY_END,
  WIKI_ENTRY_START,
} from "../src/wiki.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-wiki-"));
}

test("slugify lowercases and collapses unsafe characters into dashes", () => {
  assert.equal(slugify("React Hooks"), "react-hooks");
  assert.equal(slugify("  Effect   TypeScript!  "), "effect-typescript");
  assert.equal(slugify("a---b"), "a-b");
  assert.equal(slugify("---trim---"), "trim");
});

test("slugifyQuery maps a query to a stable filesystem-safe slug", () => {
  assert.equal(slugifyQuery("effect typescript"), "effect-typescript");
  assert.equal(slugifyQuery("React 19 Performance Tips"), "react-19-performance-tips");
});

test("slugify limits slugs to approximately 80 characters and falls back safely", () => {
  const long = slugify("a".repeat(200));
  assert.ok(long.length <= 80);
  assert.equal(long, "a".repeat(80));
  assert.equal(slugify("!!!  ..."), "untitled");
});

test("slugifyUrl maps equivalent URLs to one stable slug", () => {
  assert.equal(slugifyUrl("https://example.com"), "example-com");
  assert.equal(slugifyUrl("https://Example.com/"), "example-com");
  assert.equal(slugifyUrl("https://example.com/docs/react/"), "example-com-docs-react");
  assert.equal(slugifyUrl("https://example.com:8443/docs"), "example-com-8443-docs");
  assert.equal(slugifyUrl("https://example.com:443/docs"), "example-com-docs");
  assert.equal(slugifyUrl("https://example.com/docs?a=1&b=2"), "example-com-docs-a-1-b-2");
  assert.equal(slugifyUrl("https://example.com/docs?b=2&a=1"), "example-com-docs-a-1-b-2");
});

test("formatWikiEntry wraps a search entry in markers with heading and metadata", () => {
  const entry = formatWikiEntry({
    topic: "effect-typescript",
    source: "web_search",
    queryOrUrl: "effect typescript",
    format: "markdown",
    title: "Web Search: effect typescript",
    text: "exa results",
    timestamp: "2026-01-01T00:00:00.000Z",
  });
  assert.ok(entry.startsWith(`${WIKI_ENTRY_START}\n## Web Search: effect typescript`));
  assert.ok(entry.includes("\ntimestamp: 2026-01-01T00:00:00.000Z\n"));
  assert.ok(entry.includes("\nsource: web_search\n"));
  assert.ok(entry.includes("\nquery: effect typescript\n"));
  assert.ok(entry.includes("\nformat: markdown\n"));
  assert.ok(entry.includes(`\n${WIKI_ENTRY_END}`));
  assert.ok(entry.includes("exa results"));
});

test("formatWikiEntry writes a URL metadata line for fetch sources", () => {
  const entry = formatWikiEntry({
    topic: "example-com",
    source: "web_fetch",
    queryOrUrl: "https://example.com/",
    format: "markdown",
    title: "https://example.com/ (text/html)",
    text: "# Hello",
  });
  assert.ok(entry.includes("\nurl: https://example.com/\n"));
  assert.ok(!entry.includes("\nquery:"));
});

test("saveWikiEntry creates the wiki directory and writes the entry file", async () => {
  const root = tempRoot();
  try {
    const result = await saveWikiEntry({
      root,
      topic: "react-hooks",
      source: "web_search",
      queryOrUrl: "React Hooks",
      format: "markdown",
      title: "Web Search: React Hooks",
      text: "hooks text",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    assert.deepEqual(result, { saved: true, topic: "react-hooks", pages: ["react-hooks.md"] });
    const file = join(root, "react-hooks.md");
    assert.equal(existsSync(file), true);
    const content = readFileSync(file, "utf8");
    assert.ok(content.includes(WIKI_ENTRY_START));
    assert.ok(content.includes(WIKI_ENTRY_END));
    assert.ok(content.includes("hooks text"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saveWikiEntry appends repeated research in order without overwriting", async () => {
  const root = tempRoot();
  try {
    await saveWikiEntry({
      root,
      topic: "react-hooks",
      source: "web_search",
      queryOrUrl: "React Hooks",
      format: "markdown",
      title: "Web Search: React Hooks",
      text: "first",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    await saveWikiEntry({
      root,
      topic: "react-hooks",
      source: "web_search",
      queryOrUrl: "React Hooks",
      format: "markdown",
      title: "Web Search: React Hooks",
      text: "second",
      timestamp: "2026-01-02T00:00:00.000Z",
    });
    const content = readFileSync(join(root, "react-hooks.md"), "utf8");
    const first = content.indexOf("first");
    const second = content.indexOf("second");
    assert.ok(first >= 0 && second >= 0);
    assert.ok(first < second, "first entry precedes the second");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saveWikiEntry tolerates write failures without throwing", async () => {
  const blocker = join(tmpdir(), `pi-code-blocker-${process.pid}-${Date.now()}`);
  writeFileSync(blocker, "occupied");
  try {
    const result = await saveWikiEntry({
      root: join(blocker, "wikis"),
      topic: "react-hooks",
      source: "web_search",
      queryOrUrl: "React Hooks",
      format: "markdown",
      title: "Web Search: React Hooks",
      text: "content",
    });
    assert.deepEqual(result, { saved: false, topic: "react-hooks", pages: [] });
  } finally {
    rmSync(blocker, { recursive: true, force: true });
  }
});