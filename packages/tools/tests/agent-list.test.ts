import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerAgentListTool } from "../src/registrations/agent-list.ts";

type RegisteredTool = {
  name: string;
  execute: (...args: unknown[]) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: { agents: Array<Record<string, unknown>> };
  }>;
};

function register(): RegisteredTool {
  let registered: RegisteredTool | undefined;
  registerAgentListTool({
    registerTool(tool: RegisteredTool) {
      registered = tool;
    },
  } as unknown as ExtensionAPI);
  assert.ok(registered);
  return registered;
}

function context(cwd: string): ExtensionContext {
  return {
    cwd,
    sessionManager: { getSessionId: () => "root-session" },
  } as unknown as ExtensionContext;
}

function writeAgent(dir: string, fileName: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, fileName),
    `---\nname: ${name}\ndescription: ${description}\n---\nagent body`,
    "utf8",
  );
}

function withUserAgentDir<T>(userDir: string, run: () => T): T {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = userDir;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

test("agent_list returns distinct winning agents sorted alphabetically with only name and description", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-agent-list-"));
  const userDir = join(cwd, "user");
  try {
    writeAgent(join(userDir, "agents"), "shared.md", "shared", "user shared");
    writeAgent(join(cwd, ".agents", "agents"), "shared.md", "shared", "project shared");
    writeAgent(join(cwd, ".pi", "agents"), "zeta.md", "zeta", "Zeta agent");
    writeAgent(join(cwd, ".claude", "agents"), "alpha.md", "alpha", "Alpha agent");

    const result = await withUserAgentDir(userDir, () =>
      register().execute("call", {}, undefined, undefined, context(cwd)),
    );

    assert.deepEqual(result.details.agents, [
      { name: "alpha", description: "Alpha agent" },
      { name: "shared", description: "project shared" },
      { name: "zeta", description: "Zeta agent" },
    ]);
    assert.equal(result.content[0]?.text, "Available agents:\n- alpha: Alpha agent\n- shared: project shared\n- zeta: Zeta agent");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("agent_list reports an empty result without a built-in default agent", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-agent-list-empty-"));
  try {
    const result = await register().execute("call", {}, undefined, undefined, context(cwd));
    assert.deepEqual(result.details, { agents: [] });
    assert.equal(result.content[0]?.text, "No agent definitions are currently available.");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
