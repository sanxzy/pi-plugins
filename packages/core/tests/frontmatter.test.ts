import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  removeFrontmatterKey,
  removeFrontmatterModel,
  setFrontmatterKey,
  setFrontmatterModel,
} from "../src/domain/agents/frontmatter.ts";

test("setFrontmatterModel replaces an existing model line, preserving everything else", () => {
  const content = [
    "---",
    "name: research",
    "description: Deep research agent",
    "model: anthropic/claude-sonnet-4-5",
    "tools: web_search, web_fetch",
    "---",
    "",
    "Research carefully.",
  ].join("\n");
  const result = setFrontmatterModel(content, "openai/gpt-5");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.changed, true);
  assert.equal(result.content, [
    "---",
    "name: research",
    "description: Deep research agent",
    "model: openai/gpt-5",
    "tools: web_search, web_fetch",
    "---",
    "",
    "Research carefully.",
  ].join("\n"));
  const parsed = parseFrontmatter(result.content);
  assert.equal(parsed.frontmatter.model, "openai/gpt-5");
  assert.equal(parsed.frontmatter.name, "research");
  assert.equal(parsed.body, "Research carefully.");
});

test("setFrontmatterModel appends the model key when absent", () => {
  const content = [
    "---",
    "name: writer",
    "description: Writes docs",
    "---",
    "",
    "Write well.",
  ].join("\n");
  const result = setFrontmatterModel(content, "anthropic/claude-sonnet-4-5");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.changed, true);
  const parsed = parseFrontmatter(result.content);
  assert.equal(parsed.frontmatter.model, "anthropic/claude-sonnet-4-5");
  assert.equal(parsed.frontmatter.name, "writer");
  assert.equal(parsed.body, "Write well.");
});

test("setFrontmatterModel reports no change when the value already matches", () => {
  const content = [
    "---",
    "name: writer",
    "description: Writes docs",
    "model: openai/gpt-5",
    "---",
    "",
    "Write well.",
  ].join("\n");
  const result = setFrontmatterModel(content, "openai/gpt-5");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.changed, false);
  assert.equal(result.content, content);
});

test("setFrontmatterModel preserves comments and quoting in the block", () => {
  const content = [
    "---",
    "# my agent",
    "name: research",
    "description: \"Quoted description\"",
    "tools: web_search",
    "---",
    "",
    "Body.",
  ].join("\n");
  const result = setFrontmatterModel(content, "openai/gpt-5");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.content, [
    "---",
    "# my agent",
    "name: research",
    "description: \"Quoted description\"",
    "tools: web_search",
    "model: openai/gpt-5",
    "---",
    "",
    "Body.",
  ].join("\n"));
});

test("setFrontmatterModel rejects an empty value", () => {
  const result = setFrontmatterModel("---\nname: x\ndescription: y\n---\nbody", "  ");
  assert.equal(result.ok, false);
});

test("removeFrontmatterModel removes the model line", () => {
  const content = [
    "---",
    "name: research",
    "description: Deep research agent",
    "model: anthropic/claude-sonnet-4-5",
    "tools: web_search",
    "---",
    "",
    "Research.",
  ].join("\n");
  const result = removeFrontmatterModel(content);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.changed, true);
  assert.equal(result.content, [
    "---",
    "name: research",
    "description: Deep research agent",
    "tools: web_search",
    "---",
    "",
    "Research.",
  ].join("\n"));
  const parsed = parseFrontmatter(result.content);
  assert.equal(parsed.frontmatter.model, undefined);
  assert.equal(parsed.body, "Research.");
});

test("removeFrontmatterModel reports no change when model is absent", () => {
  const content = "---\nname: writer\ndescription: Writes\n---\nbody";
  const result = removeFrontmatterModel(content);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.changed, false);
  assert.equal(result.content, content);
});

test("frontmatter edits leave files without a frontmatter block untouched", () => {
  const content = "# just a body\n\nno frontmatter here";
  assert.deepEqual(setFrontmatterModel(content, "openai/gpt-5"), { ok: true, content, changed: false });
  assert.deepEqual(removeFrontmatterModel(content), { ok: true, content, changed: false });
});

test("frontmatter edits preserve a trailing newline in the body", () => {
  const content = "---\nname: x\ndescription: y\n---\n\nbody line\n";
  const setResult = setFrontmatterModel(content, "openai/gpt-5");
  assert.equal(setResult.ok, true);
  if (!setResult.ok) return;
  assert.equal(setResult.content, "---\nname: x\ndescription: y\nmodel: openai/gpt-5\n---\n\nbody line\n");
  const removeResult = removeFrontmatterModel("---\nname: x\ndescription: y\nmodel: openai/gpt-5\n---\n\nbody line\n");
  assert.equal(removeResult.ok, true);
  if (!removeResult.ok) return;
  assert.equal(removeResult.content, content);
});

test("setFrontmatterKey sets a thinking key alongside model losslessly", () => {
  const content = [
    "---",
    "name: research",
    "description: Deep research agent",
    "model: anthropic/claude-sonnet-4-5",
    "---",
    "",
    "Research.",
  ].join("\n");
  const result = setFrontmatterKey(content, "thinking", "high");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.content, [
    "---",
    "name: research",
    "description: Deep research agent",
    "model: anthropic/claude-sonnet-4-5",
    "thinking: high",
    "---",
    "",
    "Research.",
  ].join("\n"));
  const parsed = parseFrontmatter(result.content);
  assert.equal(parsed.frontmatter.thinking, "high");
  assert.equal(parsed.frontmatter.model, "anthropic/claude-sonnet-4-5");
});

test("setFrontmatterKey replaces an existing thinking value", () => {
  const content = "---\nname: x\ndescription: y\nthinking: low\n---\nbody";
  const result = setFrontmatterKey(content, "thinking", "high");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.content, "---\nname: x\ndescription: y\nthinking: high\n---\nbody");
});

test("removeFrontmatterKey removes a thinking key", () => {
  const content = "---\nname: x\ndescription: y\nthinking: high\n---\nbody";
  const result = removeFrontmatterKey(content, "thinking");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.content, "---\nname: x\ndescription: y\n---\nbody");
});

test("setFrontmatterKey does not touch a different key with a similar name", () => {
  const content = "---\nname: x\ndescription: y\nmodel: openai/gpt-5\n---\nbody";
  const result = setFrontmatterKey(content, "model2", "openai/gpt-5");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // The distinct key is appended; the original model key is untouched.
  assert.match(result.content, /^model: openai\/gpt-5$/m);
  assert.match(result.content, /^model2: openai\/gpt-5$/m);
});
