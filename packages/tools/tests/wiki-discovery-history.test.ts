import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { homeSessionDirFromRoot } from "@xzy-ai/runtime";
import { executeKnowledgeSearch } from "../src/registrations/knowledge-search.ts";
import { formatWikiEntry } from "../src/wiki.ts";

function root(): string {
  return mkdtempSync(join(tmpdir(), "pi-c2-wiki-discovery-history-"));
}

function writePage(
  wikiRoot: string,
  topic: string,
  file = `${topic}.md`,
  options: { page?: number; totalPages?: number; title?: string; body?: string; entry?: boolean } = {},
): void {
  const page = options.page ?? 1;
  const totalPages = options.totalPages ?? 1;
  const links = [
    page > 1 ? `previous: ${topic}${page === 2 ? ".md" : `.part-${String(page - 1).padStart(3, "0")}.md`}` : "",
    page < totalPages ? `next: ${topic}${page === 1 ? ".part-002.md" : `.part-${String(page + 1).padStart(3, "0")}.md`}` : "",
  ].filter(Boolean);
  const entry = options.entry === false ? "body-without-entry" : formatWikiEntry({
    topic,
    source: "web_search",
    queryOrUrl: topic,
    format: "markdown",
    title: options.title ?? `${topic} title`,
    text: options.body ?? `${topic} body should not appear in discovery`,
    timestamp: "2026-01-01T00:00:00.000Z",
  });
  writeFileSync(
    join(wikiRoot, file),
    `<!-- pi-c2-wiki-page -->\ntopic: ${topic}\npage: ${page}\ntotalPages: ${totalPages}${links.length ? `\n${links.join("\n")}` : ""}\n\n<!-- pi-c2-wiki-page-end -->\n\n${entry}`,
  );
}

function historyPath(projectRoot: string, sessionId: string): string {
  return join(homeSessionDirFromRoot(projectRoot, sessionId), "wiki-history.json");
}

function writeHistory(projectRoot: string, sessionId: string, records: Array<[string, string, number, number]>): void {
  const directory = homeSessionDirFromRoot(projectRoot, sessionId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "wiki-history.json"), JSON.stringify({ v: 1, r: records }));
}

function discovery(result: Awaited<ReturnType<typeof executeKnowledgeSearch>>): {
  topics: Array<{ topic: string; pages: Array<Record<string, unknown>> }>;
} {
  return (result.details as unknown as { discovery: { topics: Array<{ topic: string; pages: Array<Record<string, unknown>> }> } }).discovery;
}

function text(result: Awaited<ReturnType<typeof executeKnowledgeSearch>>): string {
  const item = result.content[0];
  return item?.type === "text" ? item.text : "";
}

test("wildcard discovery follows usable root history order, prunes stale records, and omits markerless pages", async () => {
  const wikiRoot = root();
  const projectRoot = root();
  writePage(wikiRoot, "alpha", "alpha.md", { title: "Alpha stored title" });
  writePage(wikiRoot, "beta", "beta.md", { title: "Beta stored title" });
  writeFileSync(join(wikiRoot, "markerless.md"), "not a marker-valid wiki page");
  writeHistory(projectRoot, "root-a", [
    ["stale", "stale.md", 99, 9999],
    ["markerless", "markerless.md", 50, 5000],
    ["beta", "beta.md", 2, 2000],
    ["alpha", "alpha.md", 3, 1000],
  ]);
  try {
    const result = await executeKnowledgeSearch(
      { type: "wikis", query: "*" },
      { wikiRoot, projectRoot, sessionId: "root-a", rootSessionId: "root-a" },
    );
    const pages = discovery(result).topics.flatMap((topic) => topic.pages);
    assert.deepEqual(pages.map((page) => page.file), ["alpha.md", "beta.md"]);
    assert.equal(pages[0]?.title, "Alpha stored title");
    assert.equal(pages[0]?.openCount, 3);
    assert.equal(pages[0]?.lastOpened, 1000);
    assert.doesNotMatch(text(result), /stale|markerless|Alpha stored title|alpha body/);
    const persisted = JSON.parse(readFileSync(historyPath(projectRoot, "root-a"), "utf8")) as { r: unknown[] };
    assert.deepEqual(persisted.r, [["beta", "beta.md", 2, 2000], ["alpha", "alpha.md", 3, 1000]]);
  } finally {
    rmSync(wikiRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("wildcard selection caps pages globally before regrouping topics", async () => {
  const wikiRoot = root();
  const projectRoot = root();
  writePage(wikiRoot, "alpha", "alpha.md");
  writePage(wikiRoot, "alpha", "alpha.part-002.md", { page: 2, totalPages: 2, title: "Alpha continuation" });
  writePage(wikiRoot, "beta", "beta.md");
  writePage(wikiRoot, "gamma", "gamma.md");
  writeHistory(projectRoot, "root-a", [
    ["alpha", "alpha.md", 1, 1000],
    ["alpha", "alpha.part-002.md", 4, 4000],
    ["beta", "beta.md", 3, 3000],
    ["gamma", "gamma.md", 2, 2000],
  ]);
  try {
    const result = await executeKnowledgeSearch(
      { type: "wikis", query: "*", maxResults: 2 },
      { wikiRoot, projectRoot, sessionId: "root-a", rootSessionId: "root-a" },
    );
    const topics = discovery(result).topics;
    assert.equal(topics.flatMap((topic) => topic.pages).length, 2);
    assert.deepEqual(topics.map((topic) => topic.topic), ["alpha", "beta"]);
    assert.deepEqual(topics[0]?.pages.map((page) => page.file), ["alpha.part-002.md"]);
    assert.deepEqual(topics[1]?.pages.map((page) => page.file), ["beta.md"]);
    assert.match(text(result), /Topic: alpha[\s\S]*alpha\.part-002\.md[\s\S]*Topic: beta[\s\S]*beta\.md/);
  } finally {
    rmSync(wikiRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("missing, invalid, and empty history fall back to all marker-valid pages", async () => {
  for (const mode of ["missing", "invalid", "empty"] as const) {
    const wikiRoot = root();
    const projectRoot = root();
    writePage(wikiRoot, "alpha");
    writePage(wikiRoot, "beta");
    if (mode === "invalid") writeHistory(projectRoot, "root-a", [["bad", "bad.md", 0, 0]]);
    if (mode === "empty") writeHistory(projectRoot, "root-a", []);
    try {
      const result = await executeKnowledgeSearch(
        { type: "wikis", query: "*" },
        { wikiRoot, projectRoot, sessionId: "root-a", rootSessionId: "root-a" },
      );
      assert.deepEqual(discovery(result).topics.flatMap((topic) => topic.pages).map((page) => page.file), ["alpha.md", "beta.md"]);
    } finally {
      rmSync(wikiRoot, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }
});

test("continuation pages use their own entry titles and entryless pages use a title-cased fallback", async () => {
  const wikiRoot = root();
  const projectRoot = root();
  writePage(wikiRoot, "react-hooks", "react-hooks.md", { title: "React overview" });
  writePage(wikiRoot, "react-hooks", "react-hooks.part-002.md", { page: 2, totalPages: 2, title: "React continuation" });
  writePage(wikiRoot, "plain-topic", "plain-topic.md", { entry: false });
  writeHistory(projectRoot, "root-a", [
    ["react-hooks", "react-hooks.md", 1, 1000],
    ["react-hooks", "react-hooks.part-002.md", 2, 2000],
    ["plain-topic", "plain-topic.md", 1, 3000],
  ]);
  try {
    const result = await executeKnowledgeSearch(
      { type: "wikis", query: "*" },
      { wikiRoot, projectRoot, sessionId: "root-a", rootSessionId: "root-a" },
    );
    const pages = discovery(result).topics.flatMap((topic) => topic.pages);
    assert.equal(pages.find((page) => page.file === "react-hooks.part-002.md")?.title, "React continuation");
    assert.equal(pages.find((page) => page.file === "plain-topic.md")?.title, "Plain Topic");
    assert.doesNotMatch(text(result), /React overview|React continuation|plain-topic body/);
  } finally {
    rmSync(wikiRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("unreadable wiki roots do not touch history and direct non-wildcard validity is pruned", async () => {
  const wikiRoot = root();
  const projectRoot = root();
  const rootFile = join(wikiRoot, "root-file");
  writeFileSync(rootFile, "not a directory");
  writeHistory(projectRoot, "root-a", [["stale", "stale.md", 1, 1000]]);
  const before = readFileSync(historyPath(projectRoot, "root-a"), "utf8");
  try {
    const unreadable = await executeKnowledgeSearch(
      { type: "wikis", query: "*" },
      { wikiRoot: rootFile, projectRoot, sessionId: "root-a", rootSessionId: "root-a" },
    );
    assert.equal(text(unreadable), "No local wiki pages found.");
    assert.equal(readFileSync(historyPath(projectRoot, "root-a"), "utf8"), before);

    writeFileSync(join(wikiRoot, "direct-only.md"), "direct page content without a wiki page marker");
    const direct = await executeKnowledgeSearch(
      { type: "wikis", topic: "direct-only", page: "1" },
      { wikiRoot, projectRoot, sessionId: "root-a", rootSessionId: "root-a", nowMs: () => 4000 },
    );
    assert.notEqual(text(direct), "No local wiki matches found.");
    const discovered = await executeKnowledgeSearch(
      { type: "wikis", query: "*" },
      { wikiRoot, projectRoot, sessionId: "root-a", rootSessionId: "root-a" },
    );
    assert.equal(discovery(discovered).topics.some((topic) => topic.topic === "direct-only"), false);
  } finally {
    rmSync(wikiRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
