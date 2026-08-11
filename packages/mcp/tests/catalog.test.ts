import assert from "node:assert/strict";
import { test } from "node:test";
import { paginate, paginateTools } from "../src/catalog.ts";
import { discoverCatalog, type ServerCatalog } from "../src/catalog.ts";

interface FakeListToolsOptions {
  timeout?: number;
  resetTimeoutOnProgress?: boolean;
  onprogress?: (progress: unknown) => void;
}

test("paginates tools across multiple cursors and stops on the final page", async () => {
  const results = await paginateTools(async (cursor) => {
    if (cursor === "page-2") return { tools: [{ name: "tool-two", inputSchema: { type: "object" } }] };
    return { tools: [{ name: "tool-one", inputSchema: { type: "object" } }], nextCursor: "page-2" };
  });
  assert.deepEqual(results.map((tool) => tool.name), ["tool-one", "tool-two"]);
});

test("rejects repeated cursors", async () => {
  await assert.rejects(
    paginateTools(async () => ({ tools: [], nextCursor: "repeat" })),
    /duplicate cursor/,
  );
});

test("rejects an excessive page sequence", async () => {
  await assert.rejects(
    paginate(
      async (cursor) => ({ items: [], nextCursor: cursor ? `${cursor}-next` : "page-1" }),
      2,
    ),
    /exceeded 2 pages/,
  );
});

test("catalog discovery applies request timeouts, progress resets, and abort signals", async () => {
  const seen: FakeListToolsOptions[] = [];
  const controller = new AbortController();
  const client = {
    getServerCapabilities: () => ({ tools: {} }),
    listTools: async (_params: unknown, options?: FakeListToolsOptions) => {
      seen.push(options ?? {});
      return { tools: [{ name: "probe", inputSchema: { type: "object" } }] };
    },
  } as never;
  const catalog = await discoverCatalog(client, 150, controller.signal);
  assert.deepEqual(catalog.tools.map((tool) => (tool as { name: string }).name), ["probe"]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.timeout, 150);
  assert.equal(seen[0]?.resetTimeoutOnProgress, true);
  assert.equal(typeof seen[0]?.onprogress, "function");
  void catalog;
});
