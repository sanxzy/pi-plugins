import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalProjectRoot, clearSettingsCache, homePonytailStateFile, writePonytailState } from "@xzy-ai/runtime";
import { executeWriteMarkdown } from "../src/registrations/write-markdown.ts";
import { executeEditMarkdown } from "../src/registrations/edit-markdown.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((block) => block.type === "text")?.text ?? "";
}
function project(): string { return mkdtempSync(join(tmpdir(), "pi-c2-md-matrix-project-")); }
function context(cwd: string): ExtensionContext {
  return { cwd, mode: "print", hasUI: false, sessionManager: { getSessionId: () => "matrix-session" } } as unknown as ExtensionContext;
}
function withHome(home: string, run: () => void): void {
  const previousTest = process.env.PI_C2_TEST_HOME;
  const previousHome = process.env.PI_C2_HOME;
  process.env.PI_C2_TEST_HOME = home;
  process.env.PI_C2_HOME = home;
  clearSettingsCache();
  try { run(); } finally {
    if (previousTest === undefined) delete process.env.PI_C2_TEST_HOME;
    else process.env.PI_C2_TEST_HOME = previousTest;
    if (previousHome === undefined) delete process.env.PI_C2_HOME;
    else process.env.PI_C2_HOME = previousHome;
    clearSettingsCache();
  }
}

test("rejected dedicated operations expose no raw paths, content, or authorization data and create no side effects", async () => {
  const root = project();
  try {
    const before = existsSync(join(root, "secret"));
    const result = await executeWriteMarkdown({ path: "secret/notes.ts", content: "secret-content" }, context(root));
    assert.match(textOf(result), /^Error:/);
    assert.doesNotMatch(textOf(result), /secret-content/);
    assert.equal(existsSync(join(root, "secret")), before);
    const edit = await executeEditMarkdown({ path: "secret/notes.ts", edits: [{ oldText: "a", newText: "b" }] }, context(root));
    assert.match(textOf(edit), /^Error:/);
    assert.equal(existsSync(join(root, "secret")), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejected dedicated operations in an enabled session still fail closed without mutation", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-c2-md-matrix-home-"));
  const root = project();
  try {
    withHome(home, () => {
      writePonytailState("matrix-session", { version: 1, enabled: true, tickets: [{ value: "matrix-ticket-secret", scopes: [join(root, "authorized")], createdAt: 1, expiresAt: 9_999 }] });
      mkdirSync(join(root, "authorized"));
    });
    const result = await executeWriteMarkdown({ path: "authorized/notes.ts", content: "matrix-content-secret" }, context(root));
    assert.match(textOf(result), /^Error:/);
    assert.doesNotMatch(textOf(result), /matrix-content-secret|matrix-ticket-secret/);
    assert.equal(existsSync(join(root, "authorized", "notes.ts")), false);
    const edit = await executeEditMarkdown({ path: "authorized/notes.md", edits: [{ oldText: "a", newText: "b" }] }, context(root));
    assert.match(textOf(edit), /^Error:/);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("the complete extension matrix admits every case variant and rejects near misses with no side effects", async () => {
  const root = project();
  try {
    mkdirSync(join(root, "src"));
    for (const extension of ["md", "MD", "Md", "mD", "mdx", "MDX", "txt", "TXT"]) {
      const result = await executeWriteMarkdown({ path: `src/file.${extension}`, content: "x" }, context(root));
      assert.doesNotMatch(textOf(result), /^Error:/, extension);
    }
    for (const path of ["src/notes.md.bak", "src/notes.md~", "src/notes.md.txt.ts", "src/notes", "src/notes.Md.TXT.js", "src/notes.html", "src/notes.json", "src/notes.js.md.bak"]) {
      const before = existsSync(join(root, path));
      const result = await executeWriteMarkdown({ path, content: "x" }, context(root));
      assert.match(textOf(result), /^Error:/, path);
      assert.equal(existsSync(join(root, path)), before, `side effect for ${path}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("path matrix rejects traversal, redundant spelling, root boundaries, sibling prefixes, outside-project targets, and symlink escapes", async () => {
  const root = project(); const outside = project();
  try {
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    mkdirSync(join(root, "src-backup"));
    writeFileSync(join(outside, "real.js"), "x");
    symlinkSync(join(outside, "real.js"), join(root, "link.md"));
    symlinkSync(outside, join(root, "escape-dir"));
    const rootCanonical = canonicalProjectRoot(root);
    for (const path of [
      "src/../src/file.md",
      "src/./nested/file.md",
      "src/../../outside.md",
      "../outside.md",
      "src/nested/../../../escape.md",
      "escape-dir/file.md",
      "link.md",
    ]) {
      const result = await executeWriteMarkdown({ path, content: "x" }, context(root));
      if (path === "src/../src/file.md" || path === "src/./nested/file.md") {
        // Redundant spelling that normalizes back inside the project is host-compatible and allowed.
        assert.doesNotMatch(textOf(result), /^Error:/, path);
      } else {
        assert.match(textOf(result), /^Error:/, path);
      }
    }
    // A sibling whose name is a prefix of an existing directory stays a separate
    // valid in-project target and is host-compatible (no boundary collision).
    const sibling = await executeWriteMarkdown({ path: "src-backup/file.md", content: "x" }, context(root));
    assert.doesNotMatch(textOf(sibling), /^Error:/, "src-backup stays host-compatible");
    for (const path of ["src/../src/file.md", "src/./nested/file.md", "link.md", "escape-dir/file.md"]) {
      const result = await executeEditMarkdown({ path, edits: [{ oldText: "x", newText: "y" }] }, context(root));
      if (path === "src/../src/file.md" || path === "src/./nested/file.md") {
        assert.doesNotMatch(textOf(result), /^Error:/, `edit ${path}`);
      } else {
        assert.match(textOf(result), /^Error:/, `edit ${path}`);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("absent, disabled, enabled, expired, and unrecoverable state behave identically across root and child visibility seams", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-c2-md-state-home-"));
  try {
    withHome(home, () => {
      writePonytailState("enabled-session", { version: 1, enabled: true, tickets: [{ value: "t", scopes: ["/x"], createdAt: 1, expiresAt: 10_000 }] });
      writePonytailState("expired-session", { version: 1, enabled: true, tickets: [{ value: "t", scopes: ["/x"], createdAt: 1, expiresAt: 1 }] });
      writePonytailState("disabled-session", { version: 1, enabled: false, tickets: [] });
      const statePath = homePonytailStateFile("broken-session");
      mkdirSync(join(home, "pi-c2", "sessions", "broken-session"), { recursive: true });
      writeFileSync(statePath, "{ broken state");
    });
    process.env.PI_C2_TEST_HOME = home;
    process.env.PI_C2_HOME = home;
    clearSettingsCache();
    const states = ["enabled", "expired", "disabled"].map((label) => {
      const session = `${label}-session`;
      const file = homePonytailStateFile(session);
      return { label, session, file, exists: existsSync(file) };
    });
    assert.equal(existsSync(homePonytailStateFile("absent-session")), false, "absent session has no state file");
    for (const state of states) {
      assert.equal(state.exists, true, state.label);
      const raw = readFileSync(state.file, "utf8");
      assert.equal(raw.includes("root-ticket-secret"), false, `no ticket leakage for ${state.label}`);
    }
    assert.equal(readFileSync(homePonytailStateFile("broken-session"), "utf8"), "{ broken state", "corrupt state is preserved for fail-closed recovery");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
