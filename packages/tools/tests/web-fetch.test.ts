import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerWebFetchTool, executeWebFetch, MAX_RESPONSE_SIZE } from "../src/registrations/web-fetch.ts";

type FetchUrl = string;

type Tool = {
  name: string;
  description: string;
  execute: (...args: unknown[]) => Promise<{
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
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

function captureTool(): Tool {
  let registered: Tool | undefined;
  registerWebFetchTool({
    registerTool(tool: Tool) {
      registered = tool;
    },
  } as unknown as ExtensionAPI);
  assert.ok(registered);
  assert.equal(registered.name, "web_fetch");
  return registered;
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

test("web_fetch is registered with a narrow source-focused description", () => {
  const tool = captureTool();
  assert.match(tool.description, /narrow/i);
  assert.match(tool.description, /web_search/i);
  assert.match(tool.description, /candidate URL/i);
  assert.match(tool.description, /search response/i);
  assert.match(tool.description, /Search local wikis and references first with knowledge_search tool;/);
});

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
  await withAgentDir(async () => {
    await withFetch(async () => new Response("hello", { headers: { "content-type": "text/plain" } }), async (requests) => {
      const result = await tool.execute(
        "call",
        { url: "  https://example.com/page  ", format: "text" },
        undefined,
        undefined,
        context,
      );
      assert.equal(text(result), "https://example.com/page (text/plain)\n\nhello");
      assert.deepEqual(result.details, { wiki: { saved: true, topic: "example-com-page", pages: ["example-com-page.md"] } });
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.input, "https://example.com/page");
      assert.equal(requests[0]?.init?.method, "GET");
      const headers = new Headers(requests[0]?.init?.headers);
      assert.match(headers.get("user-agent") ?? "", /^Mozilla\/5\.0/);
      assert.match(headers.get("accept") ?? "", /text\/plain/);
      assert.equal(headers.get("accept-language"), "en-US,en;q=0.9");
    });
  });
});

test("web_fetch converts HTML to markdown and text without active content", async () => {
  const tool = captureTool();
  const html = "<h1>Hello</h1><script>bad()</script><p>world <strong>wide</strong></p><style>.bad {}</style>";
  await withAgentDir(async () => {
    await withFetch(async () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }), async () => {
      const markdown = await tool.execute("call", { url: "https://example.com", format: "markdown" }, undefined, undefined, context);
      assert.equal(text(markdown), "https://example.com/ (text/html; charset=utf-8)\n\n# Hello\n\nworld **wide**");

      const plain = await tool.execute("call", { url: "https://example.com", format: "text" }, undefined, undefined, context);
      assert.equal(text(plain), "https://example.com/ (text/html; charset=utf-8)\n\nHelloworld wide");
    });
  });
});

test("web_fetch converts XHTML responses like HTML", async () => {
  const tool = captureTool();
  await withAgentDir(async () => {
    await withFetch(
      async () =>
        new Response("<html xmlns='http://www.w3.org/1999/xhtml'><body><h1>X</h1><p>y</p></body></html>", {
          headers: { "content-type": "application/xhtml+xml; charset=utf-8" },
        }),
      async () => {
        const result = await tool.execute("call", { url: "https://example.com/x" }, undefined, undefined, context);
        assert.equal(text(result), "https://example.com/x (application/xhtml+xml; charset=utf-8)\n\n# X\n\ny");
      },
    );
  });
});

test("web_fetch decodes a declared charset and preserves text-family responses", async () => {
  const tool = captureTool();
  const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
  await withAgentDir(async () => {
    await withFetch(async (input) => {
      const url = String(input);
      if (url.endsWith(".svg")) {
        return new Response('<svg><text>hello</text></svg>', { headers: { "content-type": "image/svg+xml" } });
      }
      return new Response(latin1, { headers: { "content-type": "text/plain; charset=windows-1252" } });
    }, async () => {
      const plain = await tool.execute("call", { url: "https://example.com/cafe" }, undefined, undefined, context);
      assert.equal(text(plain), "https://example.com/cafe (text/plain; charset=windows-1252)\n\ncafé");

      const svg = await tool.execute("call", { url: "https://example.com/image.svg" }, undefined, undefined, context);
      assert.equal(text(svg), "https://example.com/image.svg (image/svg+xml)\n\n<svg><text>hello</text></svg>");
    });
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
    assert.equal(text(status), "Error: HTTP 503: Request failed");

    const network = await tool.execute("call", { url: "https://example.com/network" }, undefined, undefined, context);
    assert.equal(text(network), "Error: socket closed");
  });
});

test("web_fetch times out stalled requests with a tool error", async () => {
  const tool = captureTool();
  await withFetch(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "TimeoutError"));
        });
      }),
    async () => {
      const result = await tool.execute(
        "call",
        { url: "https://example.com/slow", timeout: 1 },
        undefined,
        undefined,
        context,
      );
      assert.equal(text(result), "Error: Request timed out");
    },
  );
});

test("web_fetch rejects a declared content length over 5 MB before reading the body", async () => {
  const tool = captureTool();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(1024));
    },
  });
  await withFetch(
    async () => new Response(stream, { headers: { "content-length": String(MAX_RESPONSE_SIZE + 1) } }),
    async () => {
      const result = await tool.execute("call", { url: "https://example.com/declared" }, undefined, undefined, context);
      assert.equal(text(result), "Error: Response too large (exceeds 5MB limit)");
    },
  );
});

test("web_fetch cancels the stream when the body crosses 5 MB", async () => {
  const tool = captureTool();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(2 * 1024 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  await withFetch(async () => new Response(stream, { headers: { "content-type": "text/plain" } }), async () => {
    const result = await tool.execute("call", { url: "https://example.com/streamed" }, undefined, undefined, context);
    assert.equal(text(result), "Error: Response too large (exceeds 5MB limit)");
    assert.equal(cancelled, true);
  });
});

test("web_fetch retries a Cloudflare challenge once with the plain user agent", async () => {
  const tool = captureTool();
  let calls = 0;
  const userAgents: string[] = [];
  await withAgentDir(async () => {
    await withFetch(
      async (_input, init) => {
        calls++;
        userAgents.push(new Headers(init?.headers).get("user-agent") ?? "");
        if (calls === 1) {
          return new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } });
        }
        return new Response("ok", { headers: { "content-type": "text/plain" } });
      },
      async () => {
        const result = await tool.execute("call", { url: "https://example.com/ok" }, undefined, undefined, context);
        assert.equal(text(result), "https://example.com/ok (text/plain)\n\nok");
        assert.equal(calls, 2);
        assert.match(userAgents[0] ?? "", /^Mozilla\/5\.0/);
        assert.equal(userAgents[1], "opencode");
      },
    );
  });
});

test("web_fetch does not retry other 403 responses", async () => {
  const tool = captureTool();
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      return new Response("denied", { status: 403 });
    },
    async () => {
      const result = await tool.execute("call", { url: "https://example.com/denied" }, undefined, undefined, context);
      assert.equal(text(result), "Error: HTTP 403: Request failed");
      assert.equal(calls, 1);
    },
  );
});

test("web_fetch returns raster images as a text note plus a base64 image block", async () => {
  const tool = captureTool();
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  await withAgentDir(async (root) => {
    await withFetch(
      async () => new Response(bytes, { status: 200, headers: { "content-type": "IMAGE/PNG; charset=binary" } }),
      async () => {
        const result = await tool.execute("call", { url: "https://example.com/image.png" }, undefined, undefined, context);
        assert.equal(result.content.length, 2);
        assert.equal(result.content[0]?.type, "text");
        assert.equal(result.content[0]?.text, "Image fetched successfully");
        assert.equal(result.content[1]?.type, "image");
        assert.equal(result.content[1]?.mimeType, "image/png");
        assert.equal(result.content[1]?.data, Buffer.from(bytes).toString("base64"));
        assert.equal(result.content[1]?.data.startsWith("data:"), false);
        assert.deepEqual(result.details, { wiki: { saved: true, topic: "example-com-image-png", pages: ["example-com-image-png.md"] } });
        const saved = readFileSync(join(root, "example-com-image-png.md"), "utf8");
        assert.ok(saved.includes("Image fetched successfully"));
        assert.equal(saved.includes(Buffer.from(bytes).toString("base64")), false);
      },
    );
  });
});

test("web_fetch does not save an empty raster image body", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-c2-wiki-"));
  mkdirSync(root, { recursive: true });
  try {
    await withFetch(async () => new Response(new Uint8Array(), { headers: { "content-type": "image/png" } }), async () => {
      const result = await executeWebFetch(
        { url: "https://example.com/empty.png" },
        undefined,
        { wikiRoot: root },
      );
      assert.equal(result.content.length, 2);
      assert.equal(text(result), "Image fetched successfully");
      assert.deepEqual(result.details, {});
      assert.deepEqual(readdirSync(root), []);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("web_fetch keeps SVG responses as text output", async () => {
  const tool = captureTool();
  await withAgentDir(async () => {
    await withFetch(
      async () => new Response('<svg><text>hello</text></svg>', { headers: { "content-type": "image/svg+xml; charset=UTF-8" } }),
      async () => {
        const result = await tool.execute("call", { url: "https://example.com/image.svg" }, undefined, undefined, context);
        assert.equal(result.content.length, 1);
        assert.equal(result.content[0]?.type, "text");
        assert.equal(
          text(result),
          "https://example.com/image.svg (image/svg+xml; charset=UTF-8)\n\n<svg><text>hello</text></svg>",
        );
      },
    );
  });
});

test("web_fetch saves text results with URL and content-type metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-c2-wiki-"));
  try {
    await withFetch(async () => new Response("# Hello", { headers: { "content-type": "text/markdown" } }), async () => {
      const result = await executeWebFetch(
        { url: "https://Example.com/docs/" },
        undefined,
        { wikiRoot: root, now: () => new Date("2026-01-01T00:00:00.000Z") },
      );
      assert.equal(text(result), "https://example.com/docs/ (text/markdown)\n\n# Hello");
      assert.deepEqual(result.details, { wiki: { saved: true, topic: "example-com-docs", pages: ["example-com-docs.md"] } });
      const saved = readFileSync(join(root, "example-com-docs.md"), "utf8");
      assert.ok(saved.includes("source: web_fetch"));
      assert.ok(saved.includes("url: https://example.com/docs/"));
      assert.ok(saved.includes("format: markdown"));
      assert.ok(saved.includes("# Hello"));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("web_fetch does not save empty text bodies or unsupported binary responses", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-c2-wiki-"));
  mkdirSync(root, { recursive: true });
  try {
    await withFetch(async (input) => {
      if (String(input).endsWith("/empty")) return new Response("", { headers: { "content-type": "text/plain" } });
      return new Response(new Uint8Array([0, 1, 2]), { headers: { "content-type": "application/pdf" } });
    }, async () => {
      const empty = await executeWebFetch({ url: "https://example.com/empty" }, undefined, { wikiRoot: root });
      assert.equal(text(empty), "https://example.com/empty (text/plain)\n\n");
      assert.deepEqual(empty.details, {});
      const binary = await executeWebFetch({ url: "https://example.com/file.pdf" }, undefined, { wikiRoot: root });
      assert.equal(text(binary), "Unsupported binary content-type: application/pdf");
      assert.deepEqual(binary.details, {});
      assert.deepEqual(readdirSync(root), []);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("web_fetch keeps a successful result when wiki persistence fails", async () => {
  const blocker = join(tmpdir(), `pi-c2-fetch-blocker-${process.pid}-${Date.now()}`);
  writeFileSync(blocker, "occupied");
  try {
    await withFetch(async () => new Response("ok", { headers: { "content-type": "text/plain" } }), async () => {
      const result = await executeWebFetch(
        { url: "https://example.com/failure" },
        undefined,
        { wikiRoot: join(blocker, "wikis") },
      );
      assert.equal(text(result), "https://example.com/failure (text/plain)\n\nok");
      assert.deepEqual(result.details, {
        wiki: { saved: false, topic: "example-com-failure", pages: [] },
        wikiSaveError: "Unable to save wiki entry",
      });
    });
  } finally {
    rmSync(blocker, { recursive: true, force: true });
  }
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
