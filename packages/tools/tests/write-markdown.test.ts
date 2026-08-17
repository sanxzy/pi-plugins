import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalProjectRoot } from "@xzy-ai/runtime";
import { executeWriteMarkdown, registerWriteMarkdownTool } from "../src/registrations/write-markdown.ts";

type Tool = { name: string; parameters: { properties: Record<string, unknown>; required?: unknown; additionalProperties?: unknown } };

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((block) => block.type === "text")?.text ?? "";
}
function project(): string { return mkdtempSync(join(tmpdir(), "pi-c2-write-md-project-")); }
function context(cwd: string): ExtensionContext {
  return { cwd, mode: "print", hasUI: false, sessionManager: { getSessionId: () => "write-md-session" } } as unknown as ExtensionContext;
}

test("write_markdown exposes the write-compatible path and content contract and is distinct from the built-in write", () => {
  let tool: Tool | undefined;
  registerWriteMarkdownTool({ registerTool: (candidate: Tool) => { tool = candidate; } } as unknown as ExtensionAPI);
  assert.ok(tool, "write_markdown is registered");
  assert.equal(tool!.name, "write_markdown");
  assert.deepEqual(Object.keys(tool!.parameters.properties).sort(), ["content", "path"].sort());
  assert.deepEqual(tool!.parameters.required, ["path", "content"]);
  assert.equal(tool!.parameters.additionalProperties, false);
});

for (const extension of ["md", "MD", "Md", "mdx", "MDX", "txt", "TXT", "Mixed.TxT"]) {
  test(`write_markdown writes an allowed ${extension} target regardless of case and reports the host write result`, async () => {
    const root = project();
    try {
      const result = await executeWriteMarkdown({ path: `docs/notes.${extension}`, content: "# Notes\ncontent" }, context(root));
      const file = join(canonicalProjectRoot(root), "docs", `notes.${extension}`);
      assert.equal(existsSync(file), true, "file created");
      assert.equal(readFileSync(file, "utf8"), "# Notes\ncontent");
      assert.match(textOf(result), /Successfully wrote \d+ bytes to /);
      assert.doesNotMatch(textOf(result), /# Notes\ncontent/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const target of ["notes.txt.js", "notes", "notes.ts", "notes.json", "notes.md.bak", "notes.md ", "notes.html", "src/notes.txt.js"]) {
  test(`write_markdown rejects disallowed target ${JSON.stringify(target)} before mutation with no filesystem side effect`, async () => {
    const root = project();
    try {
      const result = await executeWriteMarkdown({ path: target, content: "secret-content" }, context(root));
      assert.match(textOf(result), /^Error:/);
      assert.doesNotMatch(textOf(result), /secret-content/);
      assert.equal(existsSync(join(root, target)), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("write_markdown rejects a symlink alias whose canonical target extension is disallowed", async () => {
  const root = project(); const outside = project();
  try {
    writeFileSync(join(outside, "secret.js"), "x");
    symlinkSync(join(outside, "secret.js"), join(root, "alias.md"));
    const result = await executeWriteMarkdown({ path: "alias.md", content: "content" }, context(root));
    assert.match(textOf(result), /^Error:/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("write_markdown rejects traversal, escapes, and outside-project targets with no side effect", async () => {
  const root = project(); const outside = project();
  try {
    mkdirSync(join(root, "src"));
    symlinkSync(outside, join(root, "escape"));
    const result = await executeWriteMarkdown({ path: "src/../../outside.md", content: "x" }, context(root));
    assert.match(textOf(result), /^Error:/);
    assert.equal(existsSync(join(root, "..", "..", "outside.md")), false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("write_markdown executor writes through the same path as the built-in host write", async () => {
  const root = project();
  try {
    const extension = await import("@earendil-works/pi-coding-agent");
    const { createWriteTool } = extension as unknown as { createWriteTool: (cwd: string) => { execute: (id: string, args: { path: string; content: string }) => Promise<unknown> } };
    const tool = createWriteTool(canonicalProjectRoot(root));
    await tool.execute("call", { path: "docs/notes.md", content: "host-write" });
    assert.equal(readFileSync(join(canonicalProjectRoot(root), "docs", "notes.md"), "utf8"), "host-write");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
