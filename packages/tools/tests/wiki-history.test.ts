import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { homeSessionDirFromRoot } from "@xzy-ai/runtime";
import { executeKnowledgeSearch } from "../src/registrations/knowledge-search.ts";
import { formatWikiEntry } from "../src/wiki.ts";

function root(): string {
  return mkdtempSync(join(tmpdir(), "pi-c2-wiki-history-"));
}

function page(wikiRoot: string, topic: string, body = topic): string {
  const file = join(wikiRoot, `${topic}.md`);
  writeFileSync(
    file,
    `<!-- pi-c2-wiki-page -->\ntopic: ${topic}\npage: 1\ntotalPages: 1\n\n<!-- pi-c2-wiki-page-end -->\n\n${formatWikiEntry({
      topic,
      source: "web_search",
      queryOrUrl: topic,
      format: "markdown",
      title: `${topic} title`,
      text: body,
      timestamp: "2026-01-01T00:00:00.000Z",
    })}`,
  );
  return file;
}

function historyPath(projectRoot: string, sessionId: string): string {
  return join(homeSessionDirFromRoot(projectRoot, sessionId), "wiki-history.json");
}

function history(projectRoot: string, sessionId: string): { v: number; r: Array<[string, string, number, number]> } {
  return JSON.parse(readFileSync(historyPath(projectRoot, sessionId), "utf8")) as { v: number; r: Array<[string, string, number, number]> };
}

function direct(
  wikiRoot: string,
  projectRoot: string,
  topic: string,
  options: { sessionId?: string; rootSessionId?: string; nowMs?: number } = {},
) {
  return executeKnowledgeSearch(
    { type: "wikis", topic, page: "1" },
    {
      wikiRoot,
      projectRoot,
      sessionId: options.sessionId,
      rootSessionId: options.rootSessionId,
      nowMs: options.nowMs === undefined ? undefined : () => options.nowMs!,
    },
  );
}

test("successful direct lookup updates one compact history tuple and preserves the page response", async () => {
  const wikiRoot = root();
  const projectRoot = root();
  page(wikiRoot, "alpha", "full page content");
  const expected = readFileSync(join(wikiRoot, "alpha.md"), "utf8");
  try {
    const first = await direct(wikiRoot, projectRoot, "alpha", { sessionId: "root-a", rootSessionId: "root-a", nowMs: 1000 });
    const second = await direct(wikiRoot, projectRoot, "alpha", { sessionId: "root-a", rootSessionId: "root-a", nowMs: 2000 });
    assert.equal(first.content[0]?.type, "text");
    const firstText = first.content[0]?.type === "text" ? first.content[0].text : undefined;
    const secondText = second.content[0]?.type === "text" ? second.content[0].text : undefined;
    assert.equal(firstText, expected);
    assert.equal(secondText, expected);
    assert.deepEqual(history(projectRoot, "root-a"), { v: 1, r: [["alpha", "alpha.md", 2, 2000]] });
  } finally {
    rmSync(wikiRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("failed direct lookups do not create or update history", async () => {
  const wikiRoot = root();
  const projectRoot = root();
  page(wikiRoot, "alpha");
  try {
    const missing = await direct(wikiRoot, projectRoot, "missing", { sessionId: "root-a", rootSessionId: "root-a", nowMs: 1000 });
    const outOfRange = await executeKnowledgeSearch(
      { type: "wikis", topic: "alpha", page: "2" },
      { wikiRoot, projectRoot, sessionId: "root-a", rootSessionId: "root-a", nowMs: () => 2000 },
    );
    const missingText = missing.content[0]?.type === "text" ? missing.content[0].text : undefined;
    const outOfRangeText = outOfRange.content[0]?.type === "text" ? outOfRange.content[0].text : undefined;
    assert.equal(missingText, "No local wiki matches found.");
    assert.equal(outOfRangeText, "No local wiki matches found.");
    assert.equal(existsSync(historyPath(projectRoot, "root-a")), false);
  } finally {
    rmSync(wikiRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("child sessions share their owning root history while distinct roots remain isolated", async () => {
  const wikiRoot = root();
  const projectRoot = root();
  page(wikiRoot, "alpha");
  page(wikiRoot, "beta");
  try {
    await direct(wikiRoot, projectRoot, "alpha", { sessionId: "root-a", rootSessionId: "root-a", nowMs: 1000 });
    await direct(wikiRoot, projectRoot, "alpha", { sessionId: "child-a", rootSessionId: "root-a", nowMs: 2000 });
    await direct(wikiRoot, projectRoot, "beta", { sessionId: "root-b", rootSessionId: "root-b", nowMs: 3000 });
    assert.deepEqual(history(projectRoot, "root-a"), { v: 1, r: [["alpha", "alpha.md", 2, 2000]] });
    assert.deepEqual(history(projectRoot, "root-b"), { v: 1, r: [["beta", "beta.md", 1, 3000]] });
    assert.equal(existsSync(historyPath(projectRoot, "child-a")), false);
  } finally {
    rmSync(wikiRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("missing session identity bypasses history without changing direct lookup", async () => {
  const wikiRoot = root();
  const projectRoot = root();
  const file = page(wikiRoot, "alpha");
  try {
    const result = await direct(wikiRoot, projectRoot, "alpha");
    const resultText = result.content[0]?.type === "text" ? result.content[0].text : undefined;
    assert.equal(resultText, readFileSync(file, "utf8"));
    assert.equal(existsSync(join(projectRoot, "wiki-history.json")), false);
  } finally {
    rmSync(wikiRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("history normalization preserves valid tuples, drops invalid records, and uses the compact envelope", async () => {
  const wikiRoot = root();
  const projectRoot = root();
  page(wikiRoot, "alpha");
  const sessionDir = join(homeSessionDirFromRoot(projectRoot, "root-a"));
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, "wiki-history.json"),
    JSON.stringify({ v: 1, r: [["alpha", "alpha.md", 2, 1000], ["bad"], ["bad", "bad.md", 0, 20], ["bad", "bad.md", 1, "no"]] }),
  );
  try {
    await direct(wikiRoot, projectRoot, "alpha", { sessionId: "root-a", rootSessionId: "root-a", nowMs: 2000 });
    assert.deepEqual(history(projectRoot, "root-a"), { v: 1, r: [["alpha", "alpha.md", 3, 2000]] });
    assert.equal(readFileSync(historyPath(projectRoot, "root-a"), "utf8").includes("openCount"), false);
  } finally {
    rmSync(wikiRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("history evicts the least recently opened page at the 50-record bound", async () => {
  const wikiRoot = root();
  const projectRoot = root();
  for (let index = 0; index < 51; index++) page(wikiRoot, `topic-${String(index).padStart(2, "0")}`);
  try {
    for (let index = 0; index < 51; index++) {
      await direct(wikiRoot, projectRoot, `topic-${String(index).padStart(2, "0")}`, {
        sessionId: "root-a",
        rootSessionId: "root-a",
        nowMs: index + 1,
      });
    }
    const records = history(projectRoot, "root-a").r;
    assert.equal(records.length, 50);
    assert.equal(records.some((record) => record[1] === "topic-00.md"), false);
    assert.equal(records.some((record) => record[1] === "topic-50.md"), true);
  } finally {
    rmSync(wikiRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
