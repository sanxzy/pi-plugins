import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearSettingsCache } from "@xzy-ai/runtime";
import {
  registerWebSearchTool,
  executeWebSearch,
  EXA_URL,
  EXA_REST_URL,
  KEENABLE_PUBLIC_URL,
  KEENABLE_TITLE,
  KEENABLE_URL,
  NO_RESULTS,
  SEARCH_TIMEOUT_MS,
} from "../src/registrations/web-search.ts";
import {
  buildKeenableRequestBody,
  clampKeenableSnippetLength,
} from "../src/web-search-adapter.ts";

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

/** Redirect the pi-c2 runtime home to a temp tree so saves never touch ~/.pi. */
function withAgentDir(run: (wikiRoot: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pi-c2-agent-"));
  const previous = process.env.PI_C2_TEST_HOME;
  process.env.PI_C2_TEST_HOME = root;
  return run(join(root, "pi-c2", "wikis")).finally(() => {
    if (previous === undefined) delete process.env.PI_C2_TEST_HOME;
    else process.env.PI_C2_TEST_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
}

function withWebHome(
  web: Record<string, unknown>,
  run: (home: string) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "pi-c2-web-home-"));
  mkdirSync(join(home, "pi-c2"), { recursive: true });
  writeFileSync(join(home, "pi-c2", "config.json"), JSON.stringify({ tools: { web } }));
  const previousHome = process.env.PI_C2_TEST_HOME;
  const previousExaKey = process.env.EXA_API_KEY;
  const previousKeenableKey = process.env.KEENABLE_API_KEY;
  process.env.PI_C2_TEST_HOME = home;
  delete process.env.EXA_API_KEY;
  delete process.env.KEENABLE_API_KEY;
  clearSettingsCache();
  return Promise.resolve()
    .then(() => run(home))
    .finally(() => {
      if (previousHome === undefined) delete process.env.PI_C2_TEST_HOME;
      else process.env.PI_C2_TEST_HOME = previousHome;
      if (previousExaKey === undefined) delete process.env.EXA_API_KEY;
      else process.env.EXA_API_KEY = previousExaKey;
      if (previousKeenableKey === undefined) delete process.env.KEENABLE_API_KEY;
      else process.env.KEENABLE_API_KEY = previousKeenableKey;
      clearSettingsCache();
      rmSync(home, { recursive: true, force: true });
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
  assert.match(tool.description, /broad discovery/i);
  assert.match(tool.description, /candidate URLs/i);
  assert.match(tool.description, /narrower keyword/i);
  assert.match(tool.description, /Search local wikis and references first with knowledge_search tool;/);
  assert.match(tool.description, /very expensive/i);
  assert.match(tool.description, /web_fetch.*free/i);
  assert.doesNotMatch(tool.description, /exa/i);
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
        assert.deepEqual(body.params.arguments, { query: "hello", type: "auto", numResults: 5, livecrawl: "fallback" });
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
    async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid request" } }), { status: 200 }),
    async () => {
      const result = await tool.execute("call", { query: "x" }, undefined, undefined, context);
      assert.equal(text(result), "Error: Search request failed: invalid request");
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
  const root = mkdtempSync(join(tmpdir(), "pi-c2-wiki-"));
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

test("web_search reads EXA_API_KEY per invocation and sends it only as a REST header", async () => {
  const original = process.env.EXA_API_KEY;
  process.env.EXA_API_KEY = "exa secret";
  const tool = captureTool();
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  try {
    await withFetch(
      async (input, init) => {
        requests.push({ input: String(input), init });
        return new Response(JSON.stringify({
          results: [{ title: "Keyed result", url: "https://example.com/keyed", highlights: ["keyed results"] }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      async () => {
        await withAgentDir(async () => {
          const result = await tool.execute("call", { query: "keyed" }, undefined, undefined, context);
          assert.equal(text(result), "Web Search: keyed\n\nTitle: Keyed result\nURL: https://example.com/keyed\nHighlights:\nkeyed results");
          assert.equal(JSON.stringify(result).includes("exa secret"), false);
        });
      },
    );
  } finally {
    if (original === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = original;
  }
  assert.equal(requests[0]?.input, EXA_REST_URL);
  assert.equal(new Headers(requests[0]?.init?.headers).get("authorization"), "Bearer exa secret");
  assert.equal(JSON.stringify(requests[0]?.init?.body).includes("exa secret"), false);
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
  const root = mkdtempSync(join(tmpdir(), "pi-c2-wiki-"));
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
      assert.ok(content.includes("<!-- pi-c2-wiki-entry -->"));
      assert.ok(content.includes("<!-- pi-c2-wiki-entry-end -->"));
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

test("web_search does not save whitespace-only result text", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-c2-wiki-"));
  mkdirSync(root, { recursive: true });
  try {
    await withFetch(async () => new Response(payload("  \n\t"), { status: 200 }), async () => {
      const result = await executeWebSearch(
        { query: "whitespace" },
        undefined,
        undefined,
        { wikiRoot: root },
      );
      assert.equal(text(result), "Web Search: whitespace\n\n  \n\t");
      assert.deepEqual(result.details, { query: "whitespace", provider: "exa" });
      assert.deepEqual(readdirSync(root), []);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("web_search writes no wiki entry on error and malformed branches", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-c2-wiki-"));
  mkdirSync(root, { recursive: true });
  try {
    await withFetch(
      async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid request" } }), { status: 200 }),
      async () => {
        const result = await executeWebSearch({ query: "x" }, undefined, undefined, { wikiRoot: root });
        assert.equal(text(result), "Error: Search request failed: invalid request");
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

test("web_search uses configured Keenable JSON provider and normalizes results", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-c2-keenable-home-"));
  const wikiRoot = join(home, "wikis");
  mkdirSync(wikiRoot, { recursive: true });
  const previousHome = process.env.PI_C2_TEST_HOME;
  const previousExaKey = process.env.EXA_API_KEY;
  const previousKeenableKey = process.env.KEENABLE_API_KEY;
  const originalFetch = globalThis.fetch;
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  process.env.PI_C2_TEST_HOME = home;
  delete process.env.EXA_API_KEY;
  delete process.env.KEENABLE_API_KEY;
  mkdirSync(join(home, "pi-c2"), { recursive: true });
  writeFileSync(join(home, "pi-c2", "config.json"), JSON.stringify({
    tools: { web: { provider: "keenable", keenableApiKey: "config-keen" } },
  }));
  clearSettingsCache();
  globalThis.fetch = (async (input, init) => {
    requests.push({ input: String(input), init });
    return new Response(JSON.stringify({
      query: "hello",
      mode: "pro",
      results: [{
        title: "Keen result",
        url: "https://example.com/keen",
        description: "Description",
        snippet: "Useful snippet",
        published_at: "2026-01-01T00:00:00Z",
        acquired_at: "2026-01-02T00:00:00Z",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  try {
    const result = await executeWebSearch(
      { query: "hello" },
      undefined,
      undefined,
      { wikiRoot },
    );
    assert.equal(text(result), [
      "Web Search: hello",
      "",
      "Title: Keen result",
      "URL: https://example.com/keen",
      "Published: 2026-01-01T00:00:00Z",
      "Highlights:",
      "Useful snippet",
    ].join("\n"));
    assert.deepEqual(result.details, {
      query: "hello",
      provider: "keenable",
      results: [{
        title: "Keen result",
        url: "https://example.com/keen",
        published: "2026-01-01T00:00:00Z",
        snippet: "Useful snippet",
      }],
      wiki: { saved: true, topic: "hello", pages: ["hello.md"] },
    });
    assert.equal(requests[0]?.input, "https://api.keenable.ai/v1/search");
    assert.equal(new Headers(requests[0]?.init?.headers).get("x-api-key"), "config-keen");
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
      query: "hello",
      max_results: 5,
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.PI_C2_TEST_HOME;
    else process.env.PI_C2_TEST_HOME = previousHome;
    if (previousExaKey === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = previousExaKey;
    if (previousKeenableKey === undefined) delete process.env.KEENABLE_API_KEY;
    else process.env.KEENABLE_API_KEY = previousKeenableKey;
    clearSettingsCache();
    rmSync(home, { recursive: true, force: true });
  }
});

test("Keenable request bodies clamp snippet length to the documented 180..10,000 range", () => {
  assert.equal(clampKeenableSnippetLength(undefined), undefined);
  assert.equal(clampKeenableSnippetLength(50), 180);
  assert.equal(clampKeenableSnippetLength(180), 180);
  assert.equal(clampKeenableSnippetLength(10_000), 10_000);
  assert.equal(clampKeenableSnippetLength(50_000), 10_000);
  const baseRequest = {
    query: "hello",
    numResults: 5,
    type: "auto",
    livecrawl: "fallback",
  } as const;
  assert.deepEqual(buildKeenableRequestBody({ ...baseRequest, contextMaxCharacters: 50 }), {
    query: "hello",
    max_results: 5,
    snippet_max_length: 180,
  });
  assert.deepEqual(buildKeenableRequestBody(baseRequest), {
    query: "hello",
    max_results: 5,
  });
});

test("web_search excludes X402 payment challenges from limit fallback", async () => {
  await withWebHome({ provider: "exa", exaApiKey: "exa-key", keenableApiKey: "keen-key" }, async (home) => {
    const calls: string[] = [];
    await withFetch(
      async (input) => {
        calls.push(String(input));
        if (calls.length === 1) {
          return new Response(JSON.stringify({ error: "X402_PAYMENT_REQUIRED: credits exhausted" }), { status: 402 });
        }
        return new Response(JSON.stringify({ results: [{ title: "unexpected", url: "https://example.com/unexpected" }] }), { status: 200 });
      },
      async () => {
        const result = await executeWebSearch({ query: "payment" }, undefined, undefined, { wikiRoot: join(home, "wikis") });
        assert.match(text(result), /^Error: HTTP 402:/);
        assert.deepEqual(calls, [EXA_REST_URL]);
      },
    );
  });
});

test("web_search falls back after declared and streamed oversized 429 responses", async () => {
  await withWebHome({ provider: "exa", exaApiKey: "exa-key", keenableApiKey: "keen-key", maxResponseBytes: 100 }, async (home) => {
    for (const kind of ["declared", "streamed"] as const) {
      const calls: string[] = [];
      let cancelled = false;
      await withFetch(
        async (input) => {
          calls.push(String(input));
          if (calls.length === 1 && kind === "declared") {
            return new Response("oversized", { status: 429, headers: { "content-length": "1000" } });
          }
          if (calls.length === 1) {
            return new Response(new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(101));
                controller.close();
              },
              cancel() {
                cancelled = true;
              },
            }), { status: 429 });
          }
          return new Response(JSON.stringify({ results: [{ title: "Fallback", url: "https://example.com/fallback" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
        async () => {
          const result = await executeWebSearch({ query: kind }, undefined, undefined, { wikiRoot: join(home, `wikis-${kind}`) });
          assert.match(text(result), /Title: Fallback/);
          assert.equal((result.details as { provider?: string }).provider, "keenable");
          assert.deepEqual(calls, [EXA_REST_URL, KEENABLE_URL]);
        },
      );
      if (kind === "streamed") assert.equal(cancelled, true);
    }
  });
});

test("web_search sends one UI warning and uses Keenable public fallback when unkeyed", async () => {
  await withWebHome({ provider: "exa", exaApiKey: "exa-key" }, async (home) => {
    const notifications: Array<{ message: string; level: string }> = [];
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const tool = captureTool();
    const uiContext = {
      cwd: join(home, "project"),
      hasUI: true,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    } as unknown as ExtensionContext;
    await withFetch(
      async (input, init) => {
        calls.push({ input: String(input), init });
        if (calls.length === 1) return new Response("", { status: 429 });
        return new Response(JSON.stringify({ results: [{ title: "Public fallback", url: "https://example.com/public" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      async () => {
        const result = await tool.execute("call", { query: "public fallback" }, undefined, undefined, uiContext);
        assert.match(text(result), /Title: Public fallback/);
        assert.deepEqual(notifications, [{
          message: "Web search: Exa limit reached; falling back to Keenable.",
          level: "warning",
        }]);
        assert.equal(calls[0]?.input, EXA_REST_URL);
        assert.equal(calls[1]?.input, KEENABLE_PUBLIC_URL);
        assert.equal(new Headers(calls[1]?.init?.headers).get("x-keenable-title"), KEENABLE_TITLE);
        assert.equal(new Headers(calls[1]?.init?.headers).get("x-api-key"), null);
      },
    );
  });
});

test("web_search falls back bidirectionally on Keenable rate limits and explicit credit exhaustion", async () => {
  await withWebHome({ provider: "keenable", keenableApiKey: "keen-key", exaApiKey: "exa-key" }, async (home) => {
    for (const status of [429, 402] as const) {
      const calls: string[] = [];
      const notifications: string[] = [];
      await withFetch(
        async (input) => {
          calls.push(String(input));
          if (calls.length === 1) {
            const body = status === 402 ? JSON.stringify({ error: "No credits available" }) : JSON.stringify({ error: "rate limit exceeded" });
            return new Response(body, { status });
          }
          return new Response(JSON.stringify({ results: [{ title: "Exa fallback", url: "https://example.com/exa-fallback" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
        async () => {
          const result = await executeWebSearch(
            { query: `keen-${status}` },
            undefined,
            undefined,
            { wikiRoot: join(home, `wikis-${status}`), notify: (message) => notifications.push(message) },
          );
          assert.match(text(result), /Title: Exa fallback/);
          assert.equal((result.details as { provider?: string }).provider, "exa");
          assert.deepEqual(calls, [KEENABLE_URL, EXA_REST_URL]);
          assert.deepEqual(notifications, ["Web search: Keenable limit reached; falling back to Exa."]);
        },
      );
    }
  });
});

test("web_search does not fallback for authentication, server, malformed, or empty outcomes", async () => {
  await withWebHome({ provider: "exa", exaApiKey: "exa-key", keenableApiKey: "keen-key" }, async (home) => {
    const cases = [
      { name: "auth", response: () => new Response(JSON.stringify({ message: "invalid key" }), { status: 401 }), expected: /^Error: HTTP 401:/ },
      { name: "server", response: () => new Response(JSON.stringify({ message: "server unavailable" }), { status: 503 }), expected: /^Error: HTTP 503:/ },
      { name: "malformed", response: () => new Response("{not json", { status: 200 }), expected: /^Error: Malformed search response body$/ },
      { name: "empty", response: () => new Response(JSON.stringify({ results: [] }), { status: 200 }), expected: /^No search results found\. Please try a different query\.$/ },
    ];
    for (const item of cases) {
      const calls: string[] = [];
      await withFetch(
        async (input) => {
          calls.push(String(input));
          return calls.length === 1
            ? item.response()
            : new Response(JSON.stringify({ results: [{ title: "unexpected", url: "https://example.com/unexpected" }] }), { status: 200 });
        },
        async () => {
          const result = await executeWebSearch({ query: item.name }, undefined, undefined, { wikiRoot: join(home, `wikis-${item.name}`) });
          assert.match(text(result), item.expected);
          assert.deepEqual(calls, [EXA_REST_URL]);
        },
      );
    }
  });
});

test("web_search shares one timeout budget across fallback attempts", async () => {
  await withWebHome({ provider: "exa", exaApiKey: "exa-key", keenableApiKey: "keen-key" }, async (home) => {
    const originalTimeout = AbortSignal.timeout;
    const timeoutController = new AbortController();
    const timeoutValues: number[] = [];
    const signals: AbortSignal[] = [];
    (AbortSignal as unknown as { timeout: typeof AbortSignal.timeout }).timeout = ((milliseconds: number) => {
      timeoutValues.push(milliseconds);
      return timeoutController.signal;
    }) as typeof AbortSignal.timeout;
    try {
      await withFetch(
        async (_input, init) => {
          if (init?.signal) signals.push(init.signal);
          if (signals.length === 1) return new Response("", { status: 429 });
          return new Response(JSON.stringify({ results: [{ title: "Timed fallback", url: "https://example.com/timed" }] }), { status: 200 });
        },
        async () => {
          const result = await executeWebSearch(
            { query: "shared timeout" },
            undefined,
            75,
            { wikiRoot: join(home, "wikis") },
          );
          assert.match(text(result), /Title: Timed fallback/);
        },
      );
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
    assert.deepEqual(timeoutValues, [75]);
    assert.equal(signals.length, 2);
    assert.equal(signals[0], signals[1]);
  });
});

test("web_search redacts configured secrets from combined fallback failures", async () => {
  const exaSecret = "EXA-SUPERSECRET";
  const keenableSecret = "KEENABLE-SUPERSECRET";
  await withWebHome({ provider: "exa", exaApiKey: exaSecret, keenableApiKey: keenableSecret }, async (home) => {
    let calls = 0;
    await withFetch(
      async () => {
        calls += 1;
        return calls === 1
          ? new Response(JSON.stringify({ error: `rate limit for ${exaSecret}` }), { status: 200 })
          : new Response(JSON.stringify({ message: `fallback rejected Authorization: Bearer ${keenableSecret}` }), { status: 200 });
      },
      async () => {
        const result = await executeWebSearch({ query: "secret failure" }, undefined, undefined, { wikiRoot: join(home, "wikis") });
        const output = text(result);
        assert.match(output, /^Error: Search failed with Exa/);
        assert.match(output, /Keenable fallback failed/);
        assert.equal(output.includes(exaSecret), false);
        assert.equal(output.includes(keenableSecret), false);
      },
    );
  });
});

test("web_search does not fallback for a nested Exa X402 payment tag", async () => {
  await withWebHome({ provider: "exa", keenableApiKey: "keen-key" }, async (home) => {
    const calls: string[] = [];
    await withFetch(
      async (input) => {
        calls.push(String(input));
        if (calls.length === 1) {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: {
              code: -32000,
              message: "credits exhausted",
              data: { tag: "X402_PAYMENT_REQUIRED" },
            },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ results: [{ title: "unexpected", url: "https://example.com/unexpected" }] }), { status: 200 });
      },
      async () => {
        const result = await executeWebSearch({ query: "nested-x402" }, undefined, undefined, { wikiRoot: join(home, "wikis") });
        assert.equal(text(result), "Error: Search request failed: credits exhausted");
        assert.deepEqual(calls, [EXA_URL]);
      },
    );
  });
});

test("web_search recognizes Keenable's documented insufficient-credit 402 response", async () => {
  await withWebHome({ provider: "keenable", keenableApiKey: "keen-key", exaApiKey: "exa-key" }, async (home) => {
    const calls: string[] = [];
    await withFetch(
      async (input) => {
        calls.push(String(input));
        if (calls.length === 1) {
          return new Response(JSON.stringify({
            error: "Insufficient credits",
            message: "No credits available for this API key",
          }), { status: 402 });
        }
        return new Response(JSON.stringify({ results: [{ title: "Credit fallback", url: "https://example.com/credit" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      async () => {
        const result = await executeWebSearch({ query: "credit-fallback" }, undefined, undefined, { wikiRoot: join(home, "wikis") });
        assert.match(text(result), /Title: Credit fallback/);
        assert.equal((result.details as { provider?: string }).provider, "exa");
        assert.deepEqual(calls, [KEENABLE_URL, EXA_REST_URL]);
      },
    );
  });
});

test("web_search requires explicit exhaustion wording instead of bare quota or credit terms", async () => {
  await withWebHome({ provider: "exa", exaApiKey: "exa-key", keenableApiKey: "keen-key" }, async (home) => {
    const cases = [
      { name: "credits-remaining", response: () => new Response(JSON.stringify({ error: "credits remaining: 10" }), { status: 200 }), expected: /Search request failed: credits remaining/ },
      { name: "quota-configured", response: () => new Response(JSON.stringify({ message: "quota configured for this account" }), { status: 503 }), expected: /HTTP 503:/ },
    ];
    for (const item of cases) {
      const calls: string[] = [];
      await withFetch(
        async (input) => {
          calls.push(String(input));
          return calls.length === 1
            ? item.response()
            : new Response(JSON.stringify({ results: [{ title: "unexpected", url: "https://example.com/unexpected" }] }), { status: 200 });
        },
        async () => {
          const result = await executeWebSearch({ query: item.name }, undefined, undefined, { wikiRoot: join(home, `wikis-${item.name}`) });
          assert.match(text(result), item.expected);
          assert.deepEqual(calls, [EXA_REST_URL]);
        },
      );
    }
  });
});

test("web_search recognizes grammatical credit and quota exhaustion variants", async () => {
  await withWebHome({ provider: "exa", exaApiKey: "exa-key", keenableApiKey: "keen-key" }, async (home) => {
    const messages = ["credits have been exhausted", "credits are depleted", "quota is exhausted"];
    for (const message of messages) {
      const calls: string[] = [];
      await withFetch(
        async (input) => {
          calls.push(String(input));
          return calls.length === 1
            ? new Response(JSON.stringify({ error: message }), { status: 200 })
            : new Response(JSON.stringify({ results: [{ title: "Grammar fallback", url: "https://example.com/grammar" }] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
        },
        async () => {
          const result = await executeWebSearch({ query: message }, undefined, undefined, { wikiRoot: join(home, `wikis-${messages.indexOf(message)}`) });
          assert.match(text(result), /Title: Grammar fallback/);
          assert.deepEqual(calls, [EXA_REST_URL, KEENABLE_URL]);
        },
      );
    }
  });
});

test("web_search redacts structured token fields from fallback failures", async () => {
  await withWebHome({ provider: "exa", exaApiKey: "exa-key", keenableApiKey: "keen-key" }, async (home) => {
    let calls = 0;
    await withFetch(
      async () => {
        calls += 1;
        return calls === 1
          ? new Response(JSON.stringify({ error: "rate limit" }), { status: 200 })
          : new Response(JSON.stringify({ message: '{"access_token":"OPAQUE-TOKEN","refresh_token":"REFRESH-TOKEN"}' }), { status: 200 });
      },
      async () => {
        const result = await executeWebSearch({ query: "structured secret failure" }, undefined, undefined, { wikiRoot: join(home, "wikis") });
        const output = text(result);
        assert.match(output, /^Error: Search failed with Exa/);
        assert.equal((result.details as { provider?: string }).provider, "keenable");
        assert.equal(output.includes("OPAQUE-TOKEN"), false);
        assert.equal(output.includes("REFRESH-TOKEN"), false);
      },
    );
  });
});

test("web_search redacts trimmed configured credentials from fallback failures", async () => {
  await withWebHome({ provider: "exa", exaApiKey: "  PADDED-EXA-KEY  ", keenableApiKey: "  PADDED-KEEN-KEY  " }, async (home) => {
    let calls = 0;
    await withFetch(
      async () => {
        calls += 1;
        return calls === 1
          ? new Response(JSON.stringify({ error: "rate limit" }), { status: 200 })
          : new Response(JSON.stringify({ message: "fallback rejected access_token=PADDED-KEEN-KEY" }), { status: 200 });
      },
      async () => {
        const result = await executeWebSearch({ query: "padded secret failure" }, undefined, undefined, { wikiRoot: join(home, "wikis") });
        const output = text(result);
        assert.equal(output.includes("PADDED-EXA-KEY"), false);
        assert.equal(output.includes("PADDED-KEEN-KEY"), false);
      },
    );
  });
});

test("web_search does not fallback for non-exhaustion credit wording", async () => {
  await withWebHome({ provider: "exa", exaApiKey: "exa-key", keenableApiKey: "keen-key" }, async (home) => {
    const cases = ["no credits required", "no credits configured", "credits spent: 5"];
    for (const message of cases) {
      const calls: string[] = [];
      await withFetch(
        async (input) => {
          calls.push(String(input));
          return calls.length === 1
            ? new Response(JSON.stringify({ error: message }), { status: 200 })
            : new Response(JSON.stringify({ results: [{ title: "unexpected", url: "https://example.com/unexpected" }] }), { status: 200 });
        },
        async () => {
          const result = await executeWebSearch({ query: message }, undefined, undefined, { wikiRoot: join(home, `wikis-${cases.indexOf(message)}`) });
          assert.match(text(result), /Search request failed:/);
          assert.deepEqual(calls, [EXA_REST_URL]);
        },
      );
    }
  });
});

test("web_search excludes generic payment-required tags from credit fallback", async () => {
  await withWebHome({ provider: "exa", exaApiKey: "exa-key", keenableApiKey: "keen-key" }, async (home) => {
    const calls: string[] = [];
    await withFetch(
      async (input) => {
        calls.push(String(input));
        if (calls.length === 1) {
          return new Response(JSON.stringify({ error: "credits exhausted", tag: "PAYMENT_REQUIRED" }), { status: 402 });
        }
        return new Response(JSON.stringify({ results: [{ title: "unexpected", url: "https://example.com/unexpected" }] }), { status: 200 });
      },
      async () => {
        const result = await executeWebSearch({ query: "payment-tag" }, undefined, undefined, { wikiRoot: join(home, "wikis") });
        assert.match(text(result), /^Error: HTTP 402:/);
        assert.deepEqual(calls, [EXA_REST_URL]);
      },
    );
  });
});

test("web_search caps normalized provider results to the requested count", async () => {
  await withWebHome({ provider: "exa", exaApiKey: "exa-key" }, async (home) => {
    const results = Array.from({ length: 25 }, (_, index) => ({
      title: `Result ${index + 1}`,
      url: `https://example.com/result-${index + 1}`,
    }));
    await withFetch(
      async () => new Response(JSON.stringify({ results }), { status: 200 }),
      async () => {
        const result = await executeWebSearch({ query: "bounded", numResults: 3 }, undefined, undefined, { wikiRoot: join(home, "wikis") });
        const details = result.details as { results?: Array<{ title: string }> };
        assert.equal(details.results?.length, 3);
        assert.equal((text(result).match(/^Title:/gm) ?? []).length, 3);
      },
    );
  });
});

test("web_search treats standard MCP isError envelopes as provider failures", async () => {
  await withWebHome({ provider: "exa", keenableApiKey: "keen-key" }, async (home) => {
    const calls: string[] = [];
    await withFetch(
      async (input) => {
        calls.push(String(input));
        if (calls.length === 1) {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { isError: true, content: [{ type: "text", text: "credits exhausted" }] },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ results: [{ title: "MCP fallback", url: "https://example.com/mcp-fallback" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      async () => {
        const result = await executeWebSearch({ query: "mcp-error" }, undefined, undefined, { wikiRoot: join(home, "wikis") });
        assert.match(text(result), /Title: MCP fallback/);
        assert.deepEqual(calls, [EXA_URL, KEENABLE_URL]);
      },
    );
  });
});

test("web_search handles negated limits and grammatical throttling", async () => {
  await withWebHome({ provider: "exa", exaApiKey: "exa-key", keenableApiKey: "keen-key" }, async (home) => {
    const cases = [
      { name: "negated", message: "not out of credits", fallback: false },
      { name: "throttled", message: "request is being throttled", fallback: true },
    ];
    for (const item of cases) {
      const calls: string[] = [];
      await withFetch(
        async (input) => {
          calls.push(String(input));
          return calls.length === 1
            ? new Response(JSON.stringify({ error: item.message }), { status: 200 })
            : new Response(JSON.stringify({ results: [{ title: "Throttle fallback", url: "https://example.com/throttle" }] }), { status: 200 });
        },
        async () => {
          const result = await executeWebSearch({ query: item.name }, undefined, undefined, { wikiRoot: join(home, `wikis-${item.name}`) });
          if (item.fallback) assert.match(text(result), /Title: Throttle fallback/);
          else assert.match(text(result), /Search request failed: not out of credits/);
          assert.deepEqual(calls, item.fallback ? [EXA_REST_URL, KEENABLE_URL] : [EXA_REST_URL]);
        },
      );
    }
  });
});

test("web_search stops before fallback when notification cancels the request", async () => {
  await withWebHome({ provider: "exa", exaApiKey: "exa-key", keenableApiKey: "keen-key" }, async (home) => {
    const calls: string[] = [];
    const controller = new AbortController();
    await withFetch(
      async (input) => {
        calls.push(String(input));
        return calls.length === 1
          ? new Response("", { status: 429 })
          : new Response(JSON.stringify({ results: [{ title: "unexpected", url: "https://example.com/unexpected" }] }), { status: 200 });
      },
      async () => {
        const result = await executeWebSearch(
          { query: "notification-cancel" },
          controller.signal,
          undefined,
          { wikiRoot: join(home, "wikis"), notify: () => controller.abort() },
        );
        assert.equal(text(result), "Error: Request aborted");
        assert.deepEqual(calls, [EXA_REST_URL]);
      },
    );
  });
});

test("web_search never falls back on generic 5xx responses, even with exhaustion wording", async () => {
  await withWebHome({ provider: "exa", exaApiKey: "exa-key", keenableApiKey: "keen-key" }, async (home) => {
    const cases = [
      { name: "server-rate", status: 503, body: JSON.stringify({ error: "rate limit exceeded" }) },
      { name: "server-credits", status: 500, body: JSON.stringify({ error: "credits exhausted" }) },
      { name: "server-quota", status: 503, body: JSON.stringify({ error: "quota has been depleted" }) },
    ];
    for (const item of cases) {
      const calls: string[] = [];
      await withFetch(
        async (input) => {
          calls.push(String(input));
          return calls.length === 1
            ? new Response(item.body, { status: item.status })
            : new Response(JSON.stringify({ results: [{ title: "unexpected", url: "https://example.com/unexpected" }] }), { status: 200 });
        },
        async () => {
          const result = await executeWebSearch({ query: item.name }, undefined, undefined, { wikiRoot: join(home, `wikis-${item.name}`) });
          assert.match(text(result), new RegExp(`^Error: HTTP ${item.status}:`));
          assert.deepEqual(calls, [EXA_REST_URL]);
        },
      );
    }
  });
});

test("web_search treats HTTP 402 with rate or quota wording as non-credit non-fallback", async () => {
  await withWebHome({ provider: "exa", exaApiKey: "exa-key", keenableApiKey: "keen-key" }, async (home) => {
    const cases = [
      { name: "payment-rate", body: JSON.stringify({ error: "rate limit exceeded" }) },
      { name: "payment-quota", body: JSON.stringify({ error: "quota exceeded" }) },
    ];
    for (const item of cases) {
      const calls: string[] = [];
      await withFetch(
        async (input) => {
          calls.push(String(input));
          return calls.length === 1
            ? new Response(item.body, { status: 402 })
            : new Response(JSON.stringify({ results: [{ title: "unexpected", url: "https://example.com/unexpected" }] }), { status: 200 });
        },
        async () => {
          const result = await executeWebSearch({ query: item.name }, undefined, undefined, { wikiRoot: join(home, `wikis-${item.name}`) });
          assert.match(text(result), /^Error: HTTP 402:/);
          assert.deepEqual(calls, [EXA_REST_URL]);
        },
      );
    }
  });
});

