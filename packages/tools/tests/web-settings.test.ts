import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearSettingsCache, resolveSettingsForProject } from "@xzy-ai/runtime";
import {
  executeWebSearch,
  EXA_REST_URL,
} from "../src/registrations/web-search.ts";
import {
  executeWebFetch,
} from "../src/registrations/web-fetch.ts";

function payload(text: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });
}

/** Write a minimal home config with the given web settings at a temp pi-c2 home. */
function homeWith(home: string, web: Record<string, unknown>): void {
  mkdirSync(join(home, "pi-c2"), { recursive: true });
  writeFileSync(join(home, "pi-c2", "config.json"), JSON.stringify({ tools: { web } }));
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "web-set-"));
}

function withHome(home: string, run: () => Promise<void>): Promise<void> {
  const previous = process.env.PI_C2_TEST_HOME;
  process.env.PI_C2_TEST_HOME = home;
  clearSettingsCache();
  return run().finally(() => {
    if (previous === undefined) delete process.env.PI_C2_TEST_HOME;
    else process.env.PI_C2_TEST_HOME = previous;
    clearSettingsCache();
  });
}

/** Return parsed arguments from the fetch body sent by executeWebSearch. */
function captureBody(
  impl: typeof globalThis.fetch,
): { restore: () => void; captured: Array<{ body: { params: { arguments: Record<string, unknown> } } }> } {
  const captured: Array<{ body: { params: { arguments: Record<string, unknown> } } }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    captured.push({ body: JSON.parse(String(init?.body)) });
    return impl(input, init);
  }) as typeof globalThis.fetch;
  return {
    restore: () => { globalThis.fetch = original; },
    captured,
  };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  assert.equal(block?.type, "text");
  assert.equal(typeof block.text, "string");
  return block.text as string;
}

// ── Web search ───────────────────────────────────────────────────────────────

test("web_search defaultNumResults resolves from centralized settings and defaults to 5", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-root-"));
  mkdirSync(root, { recursive: true });
  const { restore, captured } = captureBody(async () => new Response(payload("exa results"), { status: 200 }));
  try {
    await executeWebSearch({ query: "test" }, undefined, undefined, { wikiRoot: root });
    assert.equal(captured[0]?.body.params.arguments.numResults, 5, "default is 5");
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("web_search applies configured defaultNumResults, defaultSearchType, and defaultLivecrawl", async () => {
  const home = tempHome();
  homeWith(home, { defaultNumResults: 10, defaultSearchType: "deep", defaultLivecrawl: "preferred" });
  const { restore, captured } = captureBody(async () => new Response(payload("exa results"), { status: 200 }));
  await withHome(home, async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-"));
    await executeWebSearch({ query: "cfg" }, undefined, undefined, { wikiRoot: root });
    rmSync(root, { recursive: true, force: true });
    const args = captured[0]?.body.params.arguments;
    assert.equal(args?.numResults, 10, "configured defaultNumResults is used");
    assert.equal(args?.type, "deep", "configured defaultSearchType is used");
    assert.equal(args?.livecrawl, "preferred", "configured defaultLivecrawl is used");
  });
  restore();
  rmSync(home, { recursive: true, force: true });
});

test("web_search reads EXA_API_KEY first then falls back to tools.web.exaApiKey", async () => {
  const originalKey = process.env.EXA_API_KEY;
  delete process.env.EXA_API_KEY; // clear env so config key is exercised
  const home = tempHome();
  homeWith(home, { exaApiKey: "config-key" });
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    requests.push({ input: String(input), init });
    return new Response(JSON.stringify({ results: [{ title: "Keyed", url: "https://example.com/keyed", highlights: ["keyed"] }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  try {
    await withHome(home, async () => {
      const result = await executeWebSearch(
        { query: "keyed" },
        undefined,
        undefined,
        { wikiRoot: mkdtempSync(join(tmpdir(), "wiki-")) },
      );
      assert.equal(new Headers(requests[0]?.init?.headers).get("authorization"), "Bearer config-key");
      assert.equal(JSON.stringify(result).includes("config-key"), false, "key absent from results");
    });
  } finally {
    globalThis.fetch = original;
    if (originalKey === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = originalKey;
    rmSync(home, { recursive: true, force: true });
  }
  assert.equal(requests[0]?.input, EXA_REST_URL);
});

test("web_search EXA_API_KEY env wins over tools.web.exaApiKey", async () => {
  const originalKey = process.env.EXA_API_KEY;
  process.env.EXA_API_KEY = "env-key";
  const home = tempHome();
  homeWith(home, { exaApiKey: "config-key" });
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    requests.push({ input: String(input), init });
    return new Response(JSON.stringify({ results: [{ title: "Env", url: "https://example.com/env", highlights: ["env"] }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  try {
    await withHome(home, async () => {
      await executeWebSearch({ query: "k" }, undefined, undefined, { wikiRoot: mkdtempSync(join(tmpdir(), "wiki-")) });
      assert.equal(new Headers(requests[0]?.init?.headers).get("authorization"), "Bearer env-key");
      assert.equal(JSON.stringify(requests[0]?.init?.headers).includes("config-key"), false, "config key not used");
    });
  } finally {
    globalThis.fetch = original;
    if (originalKey === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = originalKey;
    rmSync(home, { recursive: true, force: true });
  }
  assert.equal(requests[0]?.input, EXA_REST_URL);
});

test("web_search maxResponseBytes is shared via the resolver", async () => {
  const home = tempHome();
  homeWith(home, { maxResponseBytes: 100 });
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(payload("too large"), {
    status: 200,
    headers: { "content-length": "200" },
  })) as typeof globalThis.fetch;
  try {
    await withHome(home, async () => {
      const result = await executeWebSearch(
        { query: "x" },
        undefined,
        undefined,
        { wikiRoot: mkdtempSync(join(tmpdir(), "wiki-")) },
      );
      assert.equal(text(result), "Error: Response too large (exceeds configured response limit)");
    });
  } finally {
    globalThis.fetch = original;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── Web fetch ────────────────────────────────────────────────────────────────

test("web_fetch fetchTimeoutSeconds default is 30s from config", async () => {
  const home = tempHome();
  homeWith(home, { fetchTimeoutSeconds: 30 });
  const originalAbortTimeout = AbortSignal.timeout;
  const observed: number[] = [];
  const replacement = ((ms: number) => {
    observed.push(ms);
    // Return a real short timer so the request resolves well before the
    // configured 30s deadline; the observed ms still proves the config applied.
    return originalAbortTimeout(50);
  }) as typeof AbortSignal.timeout;
  (AbortSignal as unknown as { timeout: typeof AbortSignal.timeout }).timeout = replacement;
  let timeoutRestored = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("ok", { headers: { "content-type": "text/plain" } })) as typeof globalThis.fetch;
  try {
    await withHome(home, async () => {
      const result = await executeWebFetch(
        { url: "https://example.com", timeout: undefined },
        undefined,
        { wikiRoot: mkdtempSync(join(tmpdir(), "wiki-")) },
      );
      assert.equal(text(result).includes("ok"), true);
    });
    assert.equal(observed[0], 30_000, "configured fetch timeout (30s) applied");
  } finally {
    globalThis.fetch = original;
    if (!timeoutRestored) {
      AbortSignal.timeout = originalAbortTimeout;
      timeoutRestored = true;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("web_fetch maxResponseBytes is shared via the resolver", async () => {
  const home = tempHome();
  homeWith(home, { maxResponseBytes: 100 });
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    // Declared length 200 is above the configured 100 limit but far below the
    // legacy 5 MiB ceiling, proving the resolved value (not a hardcoded cap) rejects it.
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(60)); },
      cancel() {},
    }), { headers: { "content-type": "text/plain", "content-length": "200" } });
  }) as typeof globalThis.fetch;
  await withHome(home, async () => {
    await assert.rejects(
      () => executeWebFetch(
        { url: "https://example.com/big", timeout: 2 },
        undefined,
        { wikiRoot: mkdtempSync(join(tmpdir(), "wiki-")) },
      ),
      /Response too large/,
    );
  });
  globalThis.fetch = original;
  rmSync(home, { recursive: true, force: true });
});

test("web_fetch clamps an explicit sub-30 timeout up to the enforced 30s floor", async () => {
  const root = mkdtempSync(join(tmpdir(), "wiki-"));
  const originalAbortTimeout = AbortSignal.timeout;
  const observed: number[] = [];
  const replacement = ((ms: number) => {
    observed.push(ms);
    return originalAbortTimeout(50); // short real timer so the request completes fast
  }) as typeof AbortSignal.timeout;
  (AbortSignal as unknown as { timeout: typeof AbortSignal.timeout }).timeout = replacement;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("ok", { headers: { "content-type": "text/plain" } })) as typeof globalThis.fetch;
  try {
    const result = await executeWebFetch(
      { url: "https://example.com/floor", timeout: 1 },
      undefined,
      { wikiRoot: root },
    );
    assert.equal(text(result).includes("ok"), true);
    assert.equal(observed[0], 30_000, "explicit sub-30 timeout is clamped to the 30s floor");
  } finally {
    globalThis.fetch = original;
    (AbortSignal as unknown as { timeout: typeof AbortSignal.timeout }).timeout = originalAbortTimeout;
    rmSync(root, { recursive: true, force: true });
  }
});

test("web provider and API keys resolve with project precedence", async () => {
  const home = tempHome();
  const project = tempHome();
  try {
    homeWith(home, {
      provider: "exa",
      exaApiKey: "home-exa",
      keenableApiKey: "home-keen",
    });
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(project, ".pi", "pi-c2.json"), JSON.stringify({
      tools: { web: { provider: "keenable", keenableApiKey: "project-keen" } },
    }));
    await withHome(home, async () => {
      const settings = resolveSettingsForProject(project);
      assert.equal(settings.tools.web.provider, "keenable");
      assert.equal(settings.tools.web.exaApiKey, "home-exa");
      assert.equal(settings.tools.web.keenableApiKey, "project-keen");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("invalid web settings fall through to defaults and do not break tool execution", async () => {
  const home = tempHome();
  homeWith(home, { defaultNumResults: -1, fetchTimeoutSeconds: 0, searchTimeoutMs: 0, defaultSearchType: "invalid" });
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(payload("fallback results"), { status: 200 })) as typeof globalThis.fetch;
  await withHome(home, async () => {
    const search = await executeWebSearch(
      { query: "fb" },
      undefined,
      undefined,
      { wikiRoot: mkdtempSync(join(tmpdir(), "wiki-")) },
    );
    assert.equal(text(search), "Web Search: fb\n\nfallback results");
  });
  globalThis.fetch = original;
  rmSync(home, { recursive: true, force: true });
});
