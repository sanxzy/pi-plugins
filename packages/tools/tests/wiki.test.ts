import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  formatWikiEntry,
  parsePageHeader,
  parseWikiEntries,
  saveWikiEntry,
  slugify,
  slugifyQuery,
  slugifyUrl,
  WIKI_ENTRY_END,
  WIKI_ENTRY_START,
  WIKI_PAGE_END,
  WIKI_PAGE_START,
} from "../src/wiki.ts";

function stripHeader(document: string): string {
  const start = document.indexOf(WIKI_PAGE_START);
  const end = document.indexOf(WIKI_PAGE_END);
  if (start >= 0 && end >= start) return document.slice(end + WIKI_PAGE_END.length).replace(/^\n+/, "");
  return document;
}

function entryDocument(
  title: string,
  source: "web_search" | "web_fetch",
  queryOrUrl: string,
  text: string,
  timestamp: string,
): string {
  return formatWikiEntry({ topic: slugifyQuery(queryOrUrl), source, queryOrUrl, format: "markdown", title, text, timestamp });
}

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

test("slugifyUrl redacts secret query values and userinfo before slugging (H7)", () => {
  const remaining = "x9-super-secret-slug-token";
  const slug = slugifyUrl(`https://example.com/docs?access_token=${remaining}&page=2`);
  assert.equal(slug.includes("super-secret-slug-token"), false, "slugified token remnant leaked into wiki filename");
  assert.equal(slug, "example-com-docs-access-token-redacted-page-2");
  const userinfo = "p8-userinfo-credential";
  const userInfoSlug = slugifyUrl(`https://user:${userinfo}@example.com/docs?a=1`);
  assert.equal(userInfoSlug.includes(userinfo), false, "slugified userinfo remnant leaked into wiki filename");
  assert.equal(userInfoSlug, "example-com-redacted-docs-a-1");
  assert.equal(slugifyUrl("https://example.com/docs?b=2&a=1&token=redacted&code=redacted"), "example-com-docs-a-1-b-2-code-redacted-token-redacted");
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

test("parseWikiEntries splits marker-delimited entries and ignores marker-like body text", () => {
  const body = `Some text that claims <!-- pi-code-wiki-entry --> but is not a real boundary.`;
  const doc =
    entryDocument("Web Search: alpha", "web_search", "alpha", `introduction ${body}`, "2026-01-01T00:00:00.000Z") +
    entryDocument("Web Search: beta", "web_search", "beta", "second body", "2026-01-02T00:00:00.000Z");
  const entries = parseWikiEntries(doc);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.title, "Web Search: alpha");
  assert.equal(entries[0]?.text.includes(body), true);
  assert.equal(entries[1]?.title, "Web Search: beta");
  assert.equal(entries[1]?.text, "second body");
});

test("parseWikiEntries exposes parsed metadata from the entry block", () => {
  const doc = entryDocument("Web Search: alpha", "web_search", "alpha", "alpha body", "2026-01-01T00:00:00.000Z");
  const entries = parseWikiEntries(doc);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.source, "web_search");
  assert.equal(entries[0]?.queryOrUrl, "alpha");
  assert.equal(entries[0]?.timestamp, "2026-01-01T00:00:00.000Z");
  assert.equal(entries[0]?.title, "Web Search: alpha");
  assert.equal(entries[0]?.text, "alpha body");
});

test("saveWikiEntry paginates oversized entries without truncation and exposes cursors", async () => {
  const root = tempRoot();
  const original = `${"first paragraph.\n\n".repeat(100)}END OF OVERSIZED ENTRY`;
  try {
    const result = await saveWikiEntry({
      root,
      topic: "large-topic",
      source: "web_search",
      queryOrUrl: "large topic",
      format: "markdown",
      title: "Large topic",
      text: original,
      timestamp: "2026-01-01T00:00:00.000Z",
      pageSize: 512,
    });
    assert.ok(result.pages.length > 1);
    assert.deepEqual(readdirSync(root).sort(), result.pages.slice().sort());
    const pages = result.pages.map((file) => readFileSync(join(root, file), "utf8"));
    assert.equal(pages.every((page) => page.length <= 512 + 512), true);
    assert.equal(pages.map(stripHeader).join("\n").includes("END OF OVERSIZED ENTRY"), true);
    assert.equal(pages.map(stripHeader).join("\n").includes("first paragraph."), true);
    const headers = pages.map((page) => parsePageHeader(page));
    assert.equal(headers[0]?.page, 1);
    assert.equal(headers[0]?.totalPages, pages.length);
    assert.equal(headers.at(-1)?.next, undefined);
    assert.equal(headers[0]?.next, result.pages[1]);
    assert.equal(headers.at(-1)?.previous, result.pages.at(-2));
    assert.ok(pages[0]?.includes("Next"));
    assert.ok(pages.at(-1)?.includes("Previous"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saveWikiEntry preserves existing single-page entries when pagination is enabled", async () => {
  const root = tempRoot();
  try {
    await saveWikiEntry({
      root,
      topic: "legacy",
      source: "web_search",
      queryOrUrl: "legacy",
      format: "markdown",
      title: "Legacy",
      text: "legacy content",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const result = await saveWikiEntry({
      root,
      topic: "legacy",
      source: "web_search",
      queryOrUrl: "legacy",
      format: "markdown",
      title: "Legacy second",
      text: "second content",
      timestamp: "2026-01-02T00:00:00.000Z",
      pageSize: 512,
    });
    assert.equal(result.pages[0], "legacy.md");
    const entries = parseWikiEntries(readFileSync(join(root, "legacy.md"), "utf8"), "legacy.md");
    assert.equal(entries.some((entry) => entry.text === "legacy content"), true);
    assert.equal(entries.some((entry) => entry.text === "second content"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("overlapping same-topic saves retain every entry", async () => {
  const root = tempRoot();
  try {
    const saves = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        saveWikiEntry({
          root,
          topic: "concurrent",
          source: "web_search",
          queryOrUrl: "concurrent",
          format: "markdown",
          title: `Concurrent ${index}`,
          text: `entry-${index}`,
          timestamp: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
          pageSize: 512,
        }),
      ),
    );
    assert.equal(saves.every((save) => save.saved), true);
    const files = readdirSync(root).filter((file) => file.endsWith(".md"));
    const all = files.map((file) => readFileSync(join(root, file), "utf8")).join("\n");
    for (let index = 0; index < 12; index++) assert.ok(all.includes(`entry-${index}`));
    assert.equal(files.some((file) => file.includes(".part-")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pagination headers expose stable page metadata", () => {
  const page = `${WIKI_PAGE_START}\ntopic: alpha\npage: 2\ntotalPages: 3\nprevious: alpha.md\nnext: alpha.part-003.md\n${WIKI_PAGE_END}\nbody`;
  assert.deepEqual(parsePageHeader(page), {
    topic: "alpha",
    page: 2,
    totalPages: 3,
    previous: "alpha.md",
    next: "alpha.part-003.md",
  });
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
    assert.deepEqual(result, { saved: false, topic: "react-hooks", pages: [], error: "Unable to save wiki entry" });
  } finally {
    rmSync(blocker, { recursive: true, force: true });
  }
});