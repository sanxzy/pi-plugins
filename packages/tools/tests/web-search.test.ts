import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  registerWebSearchTool,
  executeWebSearch,
  EXA_URL,
  NO_RESULTS,
  SEARCH_TIMEOUT_MS,
} from "../src/registrations/web-search.ts";

type FetchUrl = string;

type Tool = {
  name: string;
  description: string;
  execute: (...args: unknown[]) => Promise<{
    content: Array<{ type: string; text?: string }>;
    details: Record<string, unknown>;
  }>;
};

const context = {} as ExtensionContext;

/** Redirect the agent directory to a temp tree so saves never touch ~/.pi. */
function withAgentDir(run: (wikiRoot: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pi-code-agent-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  return run(join(root, "wikis")).finally(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
}

function captureTool(): Tool {
  let registered: Tool | undefined;
  registerWebSearchTool({
    registerTool(tool: Tool) {
      registered = tool;
    },
  } as unknown as ExtensionAPI);
  assert.ok(registered);
  assert.equal(registered.name, "web_search");
  return registered;
}

function payload(text: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });
}

async function withFetch(
  implementation: typeof globalThis.fetch,
  run: (requests: Array<{ input: FetchUrl; init?: RequestInit }>) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const requests: Array<{ input: FetchUrl; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    requests.push({ input: String(input), init });
    return implementation(input, init);
  }) as typeof globalThis.fetch;
  try {
    await run(requests);
  } finally {
    globalThis.fetch = original;
  }
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  assert.equal(block?.type, "text");
  assert.equal(typeof block.text, "string");
  return block.text as string;
}

test("web_search is registered, describes the current year, and sends a JSON-RPC tools/call", async () => {
  const tool = captureTool();
  assert.match(tool.description, new RegExp(String(new Date().getFullYear())));
  const captured: Array<{ input: string; method?: string; headers: Headers; body: unknown }> = [];
  await withAgentDir(async () => {
    await withFetch(
      async (input, init) => {
        captured.push({
          input: String(input),
          method: init?.method,
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(payload("exa results"), { status: 200, headers: { "content-type": "application/json" } });
      },
      async () => {
        const result = await tool.execute(
          "call",
          { query: "effect typescript", numResults: 3, livecrawl: "preferred", type: "fast", contextMaxCharacters: 2500 },
          undefined,
          undefined,
          context,
        );
        assert.equal(text(result), "Web Search: effect typescript\n\nexa results");
        assert.deepEqual(result.details, {
          query: "effect typescript",
          provider: "exa",
          wiki: { saved: true, topic: "effect-typescript", pages: ["effect-typescript.md"] },
        });
        const req = captured[0];
        assert.ok(req);
        assert.equal(req.input, EXA_URL);
        assert.equal(req.method, "POST");
        assert.match(req.headers.get("accept") ?? "", /application\/json.*text\/event-stream/);
        assert.deepEqual(req.body, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "web_search_exa",
            arguments: {
              query: "effect typescript",
              type: "fast",
              numResults: 3,
              livecrawl: "preferred",
              contextMaxCharacters: 2500,
            },
          },
        });
      },
    );
  });
});

test("web_search applies Exa defaults and parses SSE frames, ignoring non-JSON frames", async () => {
  const tool = captureTool();
  await withAgentDir(async () => {
    await withFetch(
      async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { params: { arguments: Record<string, unknown> } };
        assert.deepEqual(body.params.arguments, { query: "hello", type: "auto", numResults: 8, livecrawl: "fallback" });
        return new Response(`data: [DONE]\nevent: message\ndata: ${payload("search results")}\n\n`, { status: 200 });
      },
      async () => {
        const result = await tool.execute("call", { query: "hello" }, undefined, undefined, context);
        assert.equal(text(result), "Web Search: hello\n\nsearch results");
      },
    );
  });
});

test("web_search surfaces JSON-RPC errors as tool errors", async () => {
  const tool = captureTool();
  await withFetch(
    async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "rate limited" } }), { status: 200 }),
    async () => {
      const result = await tool.execute("call", { query: "x" }, undefined, undefined, context);
      assert.equal(text(result), "Error: Search request failed: rate limited");
    },
  );
});

test("web_search reports malformed response bodies as tool errors", async () => {
  const tool = captureTool();
  await withFetch(async () => new Response("{not json", { status: 200 }), async () => {
    const result = await tool.execute("call", { query: "x" }, undefined, undefined, context);
    assert.equal(text(result), "Error: Malformed search response body");
  });
});

test("web_search returns the no-results fallback for a valid empty response", async () => {
  const tool = captureTool();
  const root = mkdtempSync(join(tmpdir(), "pi-code-wiki-"));
  mkdirSync(root, { recursive: true });
  try {
    await withFetch(
      async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }), { status: 200 }),
      async () => {
        const result = await executeWebSearch({ query: "nothing" }, undefined, undefined, { wikiRoot: root });
        assert.equal(text(result), NO_RESULTS);
        assert.deepEqual(readdirSync(root), []);
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("web_search reads EXA_API_KEY per invocation and keeps it in the URL only", async () => {
  const original = process.env.EXA_API_KEY;
  process.env.EXA_API_KEY = "exa secret";
  const tool = captureTool();
  const urls: string[] = [];
  try {
    await withFetch(
      async (input) => {
        urls.push(String(input));
        return new Response(payload("keyed results"), { status: 200 });
      },
      async () => {
        await withAgentDir(async () => {
          const result = await tool.execute("call", { query: "keyed" }, undefined, undefined, context);
          assert.equal(text(result), "Web Search: keyed\n\nkeyed results");
          assert.equal(JSON.stringify(result).includes("exa secret"), false);
        });
      },
    );
  } finally {
    if (original === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = original;
  }
  assert.equal(urls[0], `${EXA_URL}?exaApiKey=exa+secret`);
});

test("web_search uses the base endpoint when no API key is present", async () => {
  const original = process.env.EXA_API_KEY;
  delete process.env.EXA_API_KEY;
  const tool = captureTool();
  const urls: string[] = [];
  try {
    await withFetch(
      async (input) => {
        urls.push(String(input));
        return new Response(payload("anon results"), { status: 200 });
      },
      async () => {
        await withAgentDir(async () => {
          const result = await tool.execute("call", { query: "anon" }, undefined, undefined, context);
          assert.equal(text(result), "Web Search: anon\n\nanon results");
        });
      },
    );
  } finally {
    if (original !== undefined) process.env.EXA_API_KEY = original;
  }
  assert.equal(urls[0], EXA_URL);
});

test("web_search saves successful research to the query wiki topic", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-wiki-"));
  try {
    await withFetch(async () => new Response(payload("exa results"), { status: 200 }), async () => {
      const result = await executeWebSearch(
        { query: "effect typescript" },
        undefined,
        undefined,
        { wikiRoot: root, now: () => new Date("2026-01-01T00:00:00.000Z") },
      );
      assert.equal(text(result), "Web Search: effect typescript\n\nexa results");
      assert.deepEqual(result.details, {
        query: "effect typescript",
        provider: "exa",
        wiki: { saved: true, topic: "effect-typescript", pages: ["effect-typescript.md"] },
      });
      const content = readFileSync(join(root, "effect-typescript.md"), "utf8");
      assert.ok(content.includes("<!-- pi-code-wiki-entry -->"));
      assert.ok(content.includes("<!-- pi-code-wiki-entry-end -->"));
      assert.ok(content.includes("## Web Search: effect typescript"));
      assert.ok(content.includes("timestamp: 2026-01-01T00:00:00.000Z"));
      assert.ok(content.includes("source: web_search"));
      assert.ok(content.includes("query: effect typescript"));
      assert.ok(content.includes("format: markdown"));
      assert.ok(content.includes("exa results"));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("web_search writes no wiki entry on error and malformed branches", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-wiki-"));
  mkdirSync(root, { recursive: true });
  try {
    await withFetch(
      async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "rate limited" } }), { status: 200 }),
      async () => {
        const result = await executeWebSearch({ query: "x" }, undefined, undefined, { wikiRoot: root });
        assert.equal(text(result), "Error: Search request failed: rate limited");
        assert.deepEqual(readdirSync(root), []);
      },
    );
    await withFetch(async () => new Response("{not json", { status: 200 }), async () => {
      const result = await executeWebSearch({ query: "x" }, undefined, undefined, { wikiRoot: root });
      assert.equal(text(result), "Error: Malformed search response body");
      assert.deepEqual(readdirSync(root), []);
    });
    await withFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "TimeoutError"));
          });
        }),
      async () => {
        const result = await executeWebSearch({ query: "slow" }, undefined, 50, { wikiRoot: root });
        assert.equal(text(result), "Error: Request timed out");
        assert.deepEqual(readdirSync(root), []);
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("web_search cancels an aborted request", async () => {
  const tool = captureTool();
  const controller = new AbortController();
  controller.abort();
  await withFetch(
    async (_input, init) => {
      assert.equal(init?.signal?.aborted, true);
      throw new DOMException("The operation was aborted", "AbortError");
    },
    async () => {
      const result = await tool.execute("call", { query: "abort" }, controller.signal, undefined, context);
      assert.equal(text(result), "Error: The operation was aborted");
    },
  );
});

test("web_search rejects a 5 MB response with stream cancellation", async () => {
  const tool = captureTool();
  let cancelled = false;
  await withFetch(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(2 * 1024 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      ),
    async () => {
      const result = await tool.execute("call", { query: "big" }, undefined, undefined, context);
      assert.equal(text(result), "Error: Response too large (exceeds 5MB limit)");
      assert.equal(cancelled, true);
    },
  );
});
