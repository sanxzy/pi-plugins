import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { CHANNEL_OPERATIONS, createSessionLogger, runWithLogContext } from "@xzy-ai/observability";
import {
  MEDIA_DOCUMENT_MAX_BYTES,
  MEDIA_PHOTO_MAX_BYTES,
  classifyMediaContentType,
  clearMediaArtifacts,
  detectMediaContentType,
  downloadMediaHttps,
  registerMediaArtifact,
  resolveMediaArtifact,
  resolveMediaSource,
  sanitizeMediaFilename,
  validateMediaContentType,
} from "../src/index.ts";

test("media download and resolve emit boundary records without secrets in parameters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-code-media-log-"));
  const logger = createSessionLogger({
    projectId: "project",
    rootSessionId: "root-session",
    eventsPath: join(dir, "events.jsonl"),
    errorsPath: join(dir, "errors.jsonl"),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  };
  try {
    await runWithLogContext(logger, async () => {
      await downloadMediaHttps("https://example.com/safe.png?querySecret=SECRET", { maxBytes: MEDIA_PHOTO_MAX_BYTES });
      await resolveMediaSource({ kind: "https", url: "https://example.com/safe.png?querySecret=SECRET" }, "photo");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const records = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const downloads = records.filter((record) => record.operation === CHANNEL_OPERATIONS.MEDIA_DOWNLOAD);
  assert.deepEqual(downloads.map((record) => record.phase), ["before", "after", "before", "after"]);
  assert.deepEqual(downloads.filter((record) => record.phase === "before").map((record) => record.parameters), [
    { maxBytes: MEDIA_PHOTO_MAX_BYTES },
    { maxBytes: MEDIA_PHOTO_MAX_BYTES },
  ]);
  const resolves = records.filter((record) => record.operation === CHANNEL_OPERATIONS.MEDIA_RESOLVE);
  assert.deepEqual(resolves.map((record) => record.phase), ["before", "after"]);
  assert.deepEqual(resolves[0]?.parameters, { mediaType: "photo", kind: "https" });
  assert.ok(!JSON.stringify(records).includes("querySecret=SECRET"), "URL query secrets must not appear in persisted records");
});

test("sanitizeMediaFilename reduces to a safe basename", () => {
  assert.equal(sanitizeMediaFilename("report.pdf"), "report.pdf");
  assert.equal(sanitizeMediaFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeMediaFilename("..\\..\\malware.exe"), "malware.exe");
  assert.equal(sanitizeMediaFilename(".hidden"), "hidden");
  assert.equal(sanitizeMediaFilename("a\u0000b.txt"), "ab.txt");
  assert.equal(sanitizeMediaFilename("\u0000"), "file");
  assert.equal(sanitizeMediaFilename(""), "file");
  assert.equal(sanitizeMediaFilename("x".repeat(999)), "x".repeat(255));
});

test("detectMediaContentType reads magic bytes for common formats", () => {
  assert.equal(detectMediaContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(detectMediaContentType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(detectMediaContentType(new Uint8Array([0x47, 0x49, 0x46, 0x38])), "image/gif");
  assert.equal(detectMediaContentType(new Uint8Array([0x25, 0x50, 0x44, 0x46])), "application/pdf");
  assert.equal(detectMediaContentType(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), "application/zip");
  assert.equal(detectMediaContentType(new Uint8Array([0x4d, 0x5a, 0x90, 0x00])), "application/x-msdownload");
  assert.equal(detectMediaContentType(new Uint8Array([0x7f, 0x45, 0x4c, 0x46])), "application/x-elf");
  assert.equal(detectMediaContentType(new Uint8Array([0x01, 0x02, 0x03])), "application/octet-stream");
});

test("classifyMediaContentType separates image, document, executable, and unknown", () => {
  assert.equal(classifyMediaContentType("image/png"), "image");
  assert.equal(classifyMediaContentType("application/pdf"), "document");
  assert.equal(classifyMediaContentType("application/x-msdownload"), "executable");
  assert.equal(classifyMediaContentType("application/x-elf"), "executable");
  assert.equal(classifyMediaContentType("application/octet-stream"), "unknown");
});

test("validateMediaContentType enforces declared-type consistency and blocks executables", () => {
  assert.deepEqual(validateMediaContentType("photo", "image/jpeg"), { ok: true });
  assert.ok(!validateMediaContentType("photo", "application/pdf").ok);
  assert.ok(!validateMediaContentType("document", "application/x-msdownload").ok);
  assert.deepEqual(validateMediaContentType("document", "application/pdf"), { ok: true });
});

test("resolveMediaSource passes a valid file_id through and rejects empty ones", async () => {
  const ok = await resolveMediaSource({ kind: "file_id", file_id: "AgAD_fake_file_id" }, "photo");
  assert.deepEqual(ok, { ok: true, source: { kind: "file_id", fileId: "AgAD_fake_file_id" } });
  const bad = await resolveMediaSource({ kind: "file_id", file_id: "" }, "photo");
  assert.ok(!bad.ok);
});

test("registerMediaArtifact and resolveMediaArtifact provide an opaque host-controlled store", () => {
  clearMediaArtifacts();
  registerMediaArtifact("art-1", {
    bytes: new Uint8Array([0xff, 0xd8, 0xff]),
    contentType: "image/jpeg",
    filename: "photo.jpg",
  }, { projectRoot: "/project", sessionId: "session-1" });
  const hit = resolveMediaArtifact("art-1", { projectRoot: "/project", sessionId: "session-1" });
  assert.equal(hit.ok, true);
  if (hit.ok) {
    assert.equal(hit.source.contentType, "image/jpeg");
    assert.equal(hit.source.filename, "photo.jpg");
  }
  const miss = resolveMediaArtifact("missing", { projectRoot: "/project", sessionId: "session-1" });
  assert.equal(miss.ok, false);
  clearMediaArtifacts();
});

test("downloadMediaHttps rejects non-HTTPS and private-network sources", async () => {
  const http = await downloadMediaHttps("http://example.com/a.png", { maxBytes: MEDIA_PHOTO_MAX_BYTES });
  assert.equal(http.ok, false);
  const privateIp = await downloadMediaHttps("https://127.0.0.1/a.png", { maxBytes: MEDIA_PHOTO_MAX_BYTES });
  assert.equal(privateIp.ok, false);
  const local = await downloadMediaHttps("https://localhost/a.png", { maxBytes: MEDIA_PHOTO_MAX_BYTES });
  assert.equal(local.ok, false);
});

test("downloadMediaHttps enforces the byte cap and unsafe redirects", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/safe.png")) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    if (url.includes("/redirect")) {
      return new Response(null, { status: 302, headers: { location: "https://example.com/safe.png" } });
    }
    throw new Error("unexpected fetch");
  };
  try {
    const ok = await downloadMediaHttps("https://example.com/safe.png", { maxBytes: MEDIA_PHOTO_MAX_BYTES });
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.deepEqual(ok.bytes, new Uint8Array([0xff, 0xd8, 0xff]));
      assert.equal(ok.contentType, "image/png");
    }
    const redirect = await downloadMediaHttps("https://example.com/redirect", { maxBytes: MEDIA_PHOTO_MAX_BYTES });
    assert.equal(redirect.ok, true, "a safe same-scheme redirect is followed");
    const tooLarge = await downloadMediaHttps("https://example.com/safe.png", { maxBytes: 2 });
    assert.equal(tooLarge.ok, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveMediaSource resolves an HTTPS source and validates its content type", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const executable = url.endsWith("a.exe");
    return new Response(executable ? new Uint8Array([0x4d, 0x5a, 0x90, 0x00]) : new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
      status: 200,
      headers: { "content-type": executable ? "application/x-msdownload" : "image/png" },
    });
  };
  try {
    const ok = await resolveMediaSource({ kind: "https", url: "https://example.com/a.png" }, "photo");
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.source.kind, "bytes");
      if (ok.source.kind === "bytes") assert.equal(ok.source.contentType, "image/png");
    }
    const mismatch = await resolveMediaSource({ kind: "https", url: "https://example.com/a.exe" }, "photo");
    assert.equal(mismatch.ok, false);
    const executable = await resolveMediaSource({ kind: "https", url: "https://example.com/a.exe" }, "document");
    assert.equal(executable.ok, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveMediaSource rejects an unavailable artifact", async () => {
  clearMediaArtifacts();
  const result = await resolveMediaSource({ kind: "artifact_id", artifact_id: "nope" }, "document");
  assert.equal(result.ok, false);
  clearMediaArtifacts();
});

test("document size limit is enforced at the source boundary", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(new Uint8Array(MEDIA_DOCUMENT_MAX_BYTES + 1), {
      status: 200,
      headers: { "content-type": "application/pdf" },
    });
  };
  try {
    const result = await resolveMediaSource({ kind: "https", url: "https://example.com/big.pdf" }, "document");
    assert.equal(result.ok, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});