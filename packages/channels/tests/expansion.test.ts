import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  discoverTelegramExpansions,
  expandTelegramCommand,
  parseTelegramTemplateArgs,
  substituteTelegramTemplateArgs,
} from "../src/expansion.ts";

const PROMPT = { name: "fix-tests", source: "prompt", sourceInfo: { path: "/prompts/fix-tests.md" } };
const SKILL = { name: "skill:generate-doc", source: "skill", sourceInfo: { path: "/skills/generate-doc/SKILL.md" } };

test("discoverTelegramExpansions maps prompts and skills to sanitized command names", () => {
  const targets = discoverTelegramExpansions([PROMPT, SKILL]);
  assert.deepEqual([...targets.keys()], ["fix_tests", "skill_generate_doc"]);
  assert.equal(targets.get("fix_tests")?.path, "/prompts/fix-tests.md");
  assert.equal(targets.get("skill_generate_doc")?.path, "/skills/generate-doc/SKILL.md");
});

test("discoverTelegramExpansions skips non-file and reserved commands", () => {
  const noPath = { name: "bare", source: "prompt" as const };
  const extension = { name: "goal", source: "extension" as const, sourceInfo: { path: "/x.ts" } };
  const targets = discoverTelegramExpansions([noPath, extension, PROMPT], new Set(["fix_tests"]));
  assert.equal(targets.size, 0);
});

test("parseTelegramTemplateArgs and substituteTelegramTemplateArgs mirror Pi template args", () => {
  const args = parseTelegramTemplateArgs("one 'two words' \"three words\"");
  assert.deepEqual(args, ["one", "two words", "three words"]);
  assert.equal(
    substituteTelegramTemplateArgs("$1 | $2 | $@ | $ARGUMENTS | ${@:2} | ${@:2:1}", args),
    "one | two words | one two words three words | one two words three words | two words three words | two words",
  );
});

test("readTelegramExpansionFile strips frontmatter from real template files", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-code-channels-expansion-"));
  const file = join(dir, "tpl.md");
  writeFileSync(file, "---\ndescription: Fix\n---\nReview $@");
  const targets = discoverTelegramExpansions([{ name: "tpl", source: "prompt", sourceInfo: { path: file } }]);
  assert.equal(expandTelegramCommand(targets, "tpl", "args"), "Review args");
});

test("expandTelegramCommand preserves arguments for templates without placeholders", () => {
  const targets = discoverTelegramExpansions([
    { name: "skill:generate-plan", source: "skill", sourceInfo: { path: "/skills/generate-plan/SKILL.md" } },
  ]);
  const expanded = expandTelegramCommand(targets, "skill_generate_plan", "F001", () => "Run the planning workflow.");
  assert.equal(expanded, "Run the planning workflow.\n\n---\nUser request arguments: F001\n---");
});