import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NameRegistry,
  collisionSuffix,
  resolvePiName,
  serverToolPiName,
  slugify,
} from "../src/naming.ts";

test("slugify normalizes server and tool names for Pi tool names", () => {
  assert.equal(slugify("My Server"), "my_server");
  assert.equal(slugify("filesystem-1.0"), "filesystem_1_0");
  assert.equal(slugify("  UPPER  "), "upper");
  assert.equal(slugify("a".repeat(200)).length <= 80, true, "slugs stay bounded");
});

test("server tool Pi names combine server and native tool names", () => {
  assert.equal(serverToolPiName("GitHub", "list-issues"), "github_list_issues");
  assert.equal(serverToolPiName("tools", "read"), "tools_read");
});

test("collision suffixes are deterministic and derived from full native identity", () => {
  const a = collisionSuffix("GitHub", "list-issues");
  const b = collisionSuffix("GitHub", "list-issues");
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{8}$/);
  // Same tool name on another server gets a different suffix.
  assert.notEqual(collisionSuffix("GitLab", "list-issues"), a);
});

test("resolvePiName keeps the base name for the first identity and suffixes later collisions", () => {
  const registry = new NameRegistry(new Set(["read", "bash"]));
  assert.equal(registry.resolve("server", "read"), "server_read");
  assert.equal(registry.resolve("tools", "bash"), "tools_bash");
  // Punctuation-normalized identities collide and the later one is suffixed.
  const first = registry.resolve("GitHub", "list-issues");
  assert.equal(first, "github_list_issues");
  const second = registry.resolve("GitHub", "list issues");
  assert.match(second, /^github_list_issues_[0-9a-f]{8}$/);

  // The one-shot helper uses the same deterministic collision policy.
  const used = new Set([first]);
  assert.match(resolvePiName(used, "GitHub", "list issues"), /^github_list_issues_[0-9a-f]{8}$/);
});

test("NameRegistry stays stable for the same identity across refreshes", () => {
  const registry = new NameRegistry();
  const a = registry.resolve("server-a", "tool-one");
  const b = registry.resolve("server-a", "tool-one");
  assert.equal(b, a, "same identity keeps its resolved name over time");
});