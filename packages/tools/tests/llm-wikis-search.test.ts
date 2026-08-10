import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  executeLlmWikisSearch,
  registerLlmWikisSearchTool,
} from "../src/registrations/llm-wikis-search.ts";

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
