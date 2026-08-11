import assert from "node:assert/strict";
import { test } from "node:test";
import { paginate, paginateTools } from "../src/catalog.ts";

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
