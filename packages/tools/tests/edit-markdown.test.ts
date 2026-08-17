import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalProjectRoot } from "@xzy-ai/runtime";
import { executeEditMarkdown, registerEditMarkdownTool } from "../src/registrations/edit-markdown.ts";

type Tool = { name: string; parameters: { properties: Record<string, unknown>; required?: unknown; additionalProperties?: unknown } };

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((block) => block.type === "text")?.text ?? "";
}
function project(): string { return mkdtempSync(join(tmpdir(), "pi-c2-edit-md-project-")); }
function context(cwd: string): ExtensionContext {
  return { cwd, mode: "print", hasUI: false, sessionManager: { getSessionId: () => "edit-md-session" } } as unknown as ExtensionContext;
}

test("edit_markdown exposes the edit-compatible path and edits contract and is distinct from the built-in edit", () => {
  let tool: Tool | undefined;
  registerEditMarkdownTool({ registerTool: (candidate: Tool) => { tool = candidate; } } as unknown as ExtensionAPI);
  assert.ok(tool, "edit_markdown is registered");
  assert.equal(tool!.name, "edit_markdown");
  assert.deepEqual(Object.keys(tool!.parameters.properties).sort(), ["edits", "path"].sort());
  assert.deepEqual(tool!.parameters.required, ["path", "edits"]);
  assert.equal(tool!.parameters.additionalProperties, false);
});

test("edit_markdown applies exact replacements on mixed-case allowed extensions and returns host-compatible edit details", async () => {
  const root = project();
  try {
    for (const extension of ["md", "MDX", "TxT"]) {
      const file = join(canonicalProjectRoot(root), "docs", `notes.${extension}`);
      mkdirSync(join(canonicalProjectRoot(root), "docs"), { recursive: true });
      writeFileSync(file, "line one\nline two\nline three\n", "utf8");
      const result = await executeEditMarkdown({ path: `docs/notes.${extension}`, edits: [{ oldText: "line two", newText: "changed two" }] }, context(root));
      assert.equal(readFileSync(file, "utf8"), "line one\nchanged two\nline three\n", extension);
      assert.match(textOf(result), /Successfully replaced 1 block\(s\)/);
      assert.match((result.details?.patch as string) ?? "", /^--- /, "host-compatible unified patch detail");
      assert.equal(typeof result.details?.firstChangedLine, "number");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("edit_markdown supports multiple disjoint edits against the original file", async () => {
  const root = project();
  try {
    const file = join(canonicalProjectRoot(root), "docs", "multi.md");
    mkdirSync(join(canonicalProjectRoot(root), "docs"), { recursive: true });
    writeFileSync(file, "a\nb\nc\n", "utf8");
    const result = await executeEditMarkdown({ path: "docs/multi.md", edits: [{ oldText: "a", newText: "A" }, { oldText: "c", newText: "C" }] }, context(root));
    assert.equal(readFileSync(file, "utf8"), "A\nb\nC\n");
    assert.match(textOf(result), /Successfully replaced 2 block\(s\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("edit_markdown preserves BOM and CRLF line endings through host normalization", async () => {
  const root = project();
  try {
    const file = join(canonicalProjectRoot(root), "docs", "bom.txt");
    mkdirSync(join(canonicalProjectRoot(root), "docs"), { recursive: true });
    writeFileSync(file, "\uFEFFalpha\r\nbeta\r\ngamma\r\n", "utf8");
    const result = await executeEditMarkdown({ path: "docs/bom.txt", edits: [{ oldText: "beta", newText: "BETA" }] }, context(root));
    assert.equal(result.content[0]?.text.includes("Error"), false);
    const written = readFileSync(file, "utf8");
    assert.equal(written.startsWith("\uFEFF"), true, "BOM preserved");
    assert.equal(written.includes("alpha\r\nBETA\r\ngamma\r\n"), true, "CRLF preserved");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("edit_markdown failed edits leave the original file unchanged and errors expose no content", async () => {
  const root = project();
  try {
    const file = join(canonicalProjectRoot(root), "docs", "fail.md");
    mkdirSync(join(canonicalProjectRoot(root), "docs"), { recursive: true });
    writeFileSync(file, "original secret content", "utf8");
    for (const edits of [
      [{ oldText: "missing text", newText: "x" }],
      [],
      [{ oldText: "", newText: "x" }],
      [{ oldText: "original", newText: "original" }],
    ]) {
      const result = await executeEditMarkdown({ path: "docs/fail.md", edits }, context(root));
      assert.match(textOf(result), /^Error:/);
      assert.doesNotMatch(textOf(result), /secret content/);
      assert.equal(readFileSync(file, "utf8"), "original secret content");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("edit_markdown rejects disallowed extensions, extensionless targets, and near misses before mutation", async () => {
  const root = project();
  try {
    mkdirSync(join(root, "docs"));
    for (const path of ["docs/notes.txt.js", "docs/notes", "docs/notes.ts", "docs/notes.md.bak"]) {
      const result = await executeEditMarkdown({ path, edits: [{ oldText: "x", newText: "y" }] }, context(root));
      assert.match(textOf(result), /^Error:/, path);
      assert.equal(existsSync(join(root, path)), false, `side effect for ${path}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("edit_markdown rejects traversal, escapes, outside-project targets, and symlink aliases to disallowed canonical extensions", async () => {
  const root = project(); const outside = project();
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(outside, "secret.js"), "secret-body");
    symlinkSync(join(outside, "secret.js"), join(root, "alias.md"));
    for (const path of ["src/../../outside.md", "../outside.md", "escape.md"]) {
      const result = await executeEditMarkdown({ path, edits: [{ oldText: "x", newText: "y" }] }, context(root));
      assert.match(textOf(result), /^Error:/, path);
    }
    const symlinkResult = await executeEditMarkdown({ path: "alias.md", edits: [{ oldText: "x", newText: "y" }] }, context(root));
    assert.match(textOf(symlinkResult), /^Error:/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
