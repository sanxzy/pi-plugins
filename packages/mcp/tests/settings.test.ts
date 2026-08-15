import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { normalizePromptResult, normalizeResourceResult, createMcpManager, userConfigPath } from "../src/index.ts";
import { resolveMcpSettings } from "../src/settings.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "mcp-settings-"));
}

function withHome(home: string, run: () => void): void {
  const previous = process.env.PI_C2_TEST_HOME;
  process.env.PI_C2_TEST_HOME = home;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.PI_C2_TEST_HOME;
    else process.env.PI_C2_TEST_HOME = previous;
  }
}

test("MCP runtime defaults come from the centralized mcp settings group", () => {
  const home = tempHome();
  try {
    mkdirSync(join(home, "pi-c2"), { recursive: true });
    writeFileSync(join(home, "pi-c2", "config.json"), JSON.stringify({ mcp: {
      startupTimeoutMs: 4_000,
      requestTimeoutMs: 5_000,
      reconnectMaxAttempts: 2,
      reconnectBaseDelayMs: 250,
      resultMaxText: 3_000,
      resultMaxAttachmentBytes: 4_000,
      oauthCallbackTimeoutMs: 6_000,
    } }));
    withHome(home, () => {
      assert.deepEqual(resolveMcpSettings("/tmp/project"), {
        startupTimeoutMs: 4_000,
        requestTimeoutMs: 5_000,
        reconnectMaxAttempts: 2,
        reconnectBaseDelayMs: 250,
        resultMaxText: 3_000,
        resultMaxAttachmentBytes: 4_000,
        oauthCallbackTimeoutMs: 6_000,
      });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("manager startup uses centralized timeout defaults when mcp.json does not override them", async () => {
  const root = tempHome();
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  mkdirSync(join(agentDir, "pi-c2"), { recursive: true });
  const fixture = new URL("./fixtures/stdio-server.ts", import.meta.url).pathname;
  writeFileSync(userConfigPath(agentDir), JSON.stringify({ mcp: { servers: {
    hanging: { type: "local", command: [process.execPath, fixture], cwd: dirname(fixture), environment: { MCP_FIXTURE_MODE: "hang" } },
  } } }));
  mkdirSync(join(root, "pi-c2"), { recursive: true });
  writeFileSync(join(root, "pi-c2", "config.json"), JSON.stringify({ mcp: { startupTimeoutMs: 1_000 } }));
  const previous = process.env.PI_C2_TEST_HOME;
  process.env.PI_C2_TEST_HOME = root;
  try {
    const manager = createMcpManager({ agentDir, projectRoot });
    const started = Date.now();
    const state = await manager.start();
    assert.equal(state.servers.hanging?.status, "failed");
    assert.ok(Date.now() - started < 5_000, "centralized startup timeout bounds the hanging server");
    await manager.stop();
  } finally {
    if (previous === undefined) delete process.env.PI_C2_TEST_HOME;
    else process.env.PI_C2_TEST_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt and resource normalization accept the centralized result limits", () => {
  const prompt = normalizePromptResult("server", "prompt", {
    messages: [{ role: "user", content: { type: "text", text: "abcdef" } }],
  }, { maxText: 3 });
  assert.equal(prompt.messages[0]?.text, "abc\n[output truncated]");

  const resource = normalizeResourceResult("server", "file:///x", {
    contents: [{ uri: "file:///x", mimeType: "text/plain", text: "abcdef" }],
  }, { maxText: 3, maxAttachmentBytes: 4 });
  // The aggregate bounded stream honors the configured text limit; the
  // per-block content list is bounded independently of the stream text.
  assert.match(resource.text, /output truncated/);
  assert.equal(resource.content?.[0]?.type, "text");
  assert.equal(resource.content?.[0]?.text, "abc\n[output truncated]");
});
