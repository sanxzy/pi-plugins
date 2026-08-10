import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerWebFetchTool } from "../src/registrations/web-fetch.ts";

type Tool = {
  name: string;
  description: string;
  execute: (...args: unknown[]) => Promise<{
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    details: Record<string, unknown>;
  }>;
};

const context = {} as ExtensionContext;

function captureTool(): Tool {
  let registered: Tool | undefined;
  registerWebFetchTool({
    registerTool(tool: Tool) {
      registered = tool;
    },
  } as unknown as ExtensionAPI);
  assert.ok(registered);
  return registered;
}

async function withFetch(
  implementation: typeof globalThis.fetch,
  run: (requests: Array<{ input: RequestInfo | URL; init?: RequestInit }>) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
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
  return block.text;
}

test("web_fetch is registered and rejects non-http URLs before fetching", async () => {
  const tool = captureTool();
  let calls = 0;
  await withFetch(async () => {
    calls++;
    return new Response("unexpected");
  }, async () => {
    const result = await tool.execute("call", { url: " ftp://example.com " }, undefined, undefined, context);
    assert.equal(text(result), "Error: URL must start with http:// or https://");
    assert.deepEqual(result.details, {});
    assert.equal(calls, 0);
  });
});

test("web_fetch trims URLs and sends browser-like format headers", async () => {
  const tool = captureTool();
  await withFetch(async () => new Response("hello", { headers: { "content-type": "text/plain" } }), async (requests) => {
    const result = await tool.execute(
      "call",
      { url: "  https://example.com/page  ", format: "text" },
      undefined,
      undefined,
      context,
    );
    assert.equal(text(result), "hello");
    assert.deepEqual(result.details, {});
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.input, "https://example.com/page");
    assert.equal(requests[0]?.init?.method, "GET");
    const headers = new Headers(requests[0]?.init?.headers);
    assert.match(headers.get("user-agent") ?? "", /^Mozilla\/5\.0/);
    assert.match(headers.get("accept") ?? "", /text\/plain/);
    assert.equal(headers.get("accept-language"), "en-US,en;q=0.9");
  });
});

test("web_fetch converts HTML to markdown and text without active content", async () => {
  const tool = captureTool();
  const html = "<h1>Hello</h1><script>bad()</script><p>world <strong>wide</strong></p><style>.bad {}</style>";
  await withFetch(async () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }), async () => {
    const markdown = await tool.execute("call", { url: "https://example.com", format: "markdown" }, undefined, undefined, context);
    assert.equal(text(markdown), "# Hello\n\nworld **wide**");

    const plain = await tool.execute("call", { url: "https://example.com", format: "text" }, undefined, undefined, context);
    assert.equal(text(plain), "Helloworld wide");
  });
});

test("web_fetch decodes a declared charset and preserves text-family responses", async () => {
  const tool = captureTool();
  const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
  await withFetch(async (input) => {
    const url = String(input);
    if (url.endsWith(".svg")) {
      return new Response('<svg><text>hello</text></svg>', { headers: { "content-type": "image/svg+xml" } });
    }
    return new Response(latin1, { headers: { "content-type": "text/plain; charset=windows-1252" } });
  }, async () => {
    const plain = await tool.execute("call", { url: "https://example.com/cafe" }, undefined, undefined, context);
    assert.equal(text(plain), "café");

    const svg = await tool.execute("call", { url: "https://example.com/image.svg" }, undefined, undefined, context);
    assert.equal(text(svg), '<svg><text>hello</text></svg>');
  });
});

test("web_fetch reports unsupported binary responses", async () => {
  const tool = captureTool();
  await withFetch(async () => new Response(new Uint8Array([0, 1, 2]), { headers: { "content-type": "application/pdf" } }), async () => {
    const result = await tool.execute("call", { url: "https://example.com/file.pdf" }, undefined, undefined, context);
    assert.equal(text(result), "Unsupported binary content-type: application/pdf");
    assert.deepEqual(result.details, {});
  });
});

test("web_fetch turns HTTP and network failures into tool errors", async () => {
  const tool = captureTool();
  await withFetch(async (input) => {
    if (String(input).endsWith("/status")) return new Response("nope", { status: 503 });
    throw new Error("socket closed");
  }, async () => {
    const status = await tool.execute("call", { url: "https://example.com/status" }, undefined, undefined, context);
    assert.equal(text(status), "Error: HTTP 503: Service Unavailable");

    const network = await tool.execute("call", { url: "https://example.com/network" }, undefined, undefined, context);
    assert.equal(text(network), "Error: socket closed");
  });
});

test("web_fetch converts an aborted request into a tool error", async () => {
  const tool = captureTool();
  const controller = new AbortController();
  controller.abort();
  await withFetch(async (_input, init) => {
    assert.equal(init?.signal?.aborted, true);
    throw new DOMException("The operation was aborted", "AbortError");
  }, async () => {
    const result = await tool.execute("call", { url: "https://example.com" }, controller.signal, undefined, context);
    assert.equal(text(result), "Error: The operation was aborted");
  });
});
