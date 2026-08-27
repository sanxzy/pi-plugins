import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJob } from "@xzy-ai/core";
import {
  createAgentEventRegistry,
  createRegistry,
  getChildPool,
  homeRoot,
  resolveSettings,
  resolveSettingsForProject,
  settingsConfigPath,
  bootstrapSettingsConfig,
} from "../src/index.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "pi-c2-settings-home-"));
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

function writeHomeConfig(home: string, value: unknown): void {
  const dir = join(home, "pi-c2");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(value));
}

function writeProjectConfig(project: string, value: unknown): void {
  const dir = join(project, ".pi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pi-c2.json"), JSON.stringify(value));
}

test("first-start bootstrap creates every settings key with resolver defaults", () => {
  const home = tempHome();
  try {
    withHome(home, () => {
      assert.equal(bootstrapSettingsConfig(), true);
      const file = settingsConfigPath();
      assert.equal(existsSync(file), true);
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      assert.deepEqual(parsed, {
        agents: { maxAgentDepth: 4, maxConcurrency: 2, maxParallelAgents: 3, retainedTerminalJobs: 25, retainedTerminalAgents: 25 },
        runtime: { deliveryRetryDelayMs: 2_000, gitTimeoutMs: 60_000, gitLockStaleMs: 30_000, gitLockAcquireTimeoutMs: 30_000, gitMaxBufferBytes: 16 * 1024 * 1024, contextCompactThresholdPercent: 80 },
        channels: { maxRootSessions: 200, lockStaleMs: 10_000, lockUpdateMs: 5_000, lockAcquireRetries: 0, maxTextLength: 4_000, pairingPendingTtlMs: 3_600_000, pairingPendingMax: 3, mediaPhotoMaxBytes: 10 * 1024 * 1024, mediaDocumentMaxBytes: 50 * 1024 * 1024, mediaTimeoutMs: 30_000 },
        tools: { ponytailEnabled: false, writeEditTicketTtlMs: 600_000, web: { provider: "exa", searchTimeoutMs: 30_000, fetchTimeoutSeconds: 30, maxResponseBytes: 5 * 1024 * 1024, defaultNumResults: 5, defaultSearchType: "auto", defaultLivecrawl: "fallback", exaApiKey: "", keenableApiKey: "" } },
        mcp: { startupTimeoutMs: 30_000, requestTimeoutMs: 30_000, reconnectMaxAttempts: 5, reconnectBaseDelayMs: 2_000, resultMaxText: 50_000, resultMaxAttachmentBytes: 5 * 1024 * 1024, oauthCallbackTimeoutMs: 5 * 60 * 1000 },
        commands: { telegram: { reactionTimeoutMs: 2_500 }, goalMaxPromptLength: 10_000 },
      });
      assert.equal(statSync(file).isFile(), true);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("concurrent first-start bootstraps publish one complete valid config", async () => {
  const home = tempHome();
  const previous = process.env.PI_C2_TEST_HOME;
  process.env.PI_C2_TEST_HOME = home;
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => Promise.resolve(bootstrapSettingsConfig())));
    assert.equal(results.filter(Boolean).length, 1);
    const parsed = JSON.parse(readFileSync(settingsConfigPath(), "utf8")) as Record<string, unknown>;
    assert.equal(typeof parsed.agents, "object");
    assert.equal(typeof parsed.commands, "object");
  } finally {
    if (previous === undefined) delete process.env.PI_C2_TEST_HOME;
    else process.env.PI_C2_TEST_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("first-start bootstrap is idempotent and never overwrites an existing config", () => {
  const home = tempHome();
  try {
    withHome(home, () => {
      assert.equal(bootstrapSettingsConfig(), true);
      const file = settingsConfigPath();
      const original = readFileSync(file, "utf8");
      writeFileSync(file, JSON.stringify({ custom: true }));
      assert.equal(bootstrapSettingsConfig(), false);
      assert.equal(readFileSync(file, "utf8"), JSON.stringify({ custom: true }));
      assert.equal(original.length > 0, true);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("bootstrap preserves malformed and partially populated existing configs", () => {
  const home = tempHome();
  try {
    withHome(home, () => {
      const file = settingsConfigPath();
      mkdirSync(join(home, "pi-c2"), { recursive: true });
      writeFileSync(file, "{ malformed");
      assert.equal(bootstrapSettingsConfig(), false);
      assert.equal(readFileSync(file, "utf8"), "{ malformed");
      writeFileSync(file, JSON.stringify({ agents: { maxConcurrency: 9 } }));
      assert.equal(bootstrapSettingsConfig(), false);
      assert.equal(readFileSync(file, "utf8"), JSON.stringify({ agents: { maxConcurrency: 9 } }));
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("bootstrap failure is non-fatal", () => {
  const home = tempHome();
  try {
    const blocked = join(home, "blocked");
    writeFileSync(blocked, "not a directory");
    withHome(home, () => {
      assert.equal(bootstrapSettingsConfig(join(blocked, "config.json")), false);
      assert.equal(resolveSettings().agents.maxAgentDepth, 4);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("settingsConfigPath resolves below homeRoot so PI_C2_HOME selects the config location", () => {
  const home = tempHome();
  try {
    withHome(home, () => {
      const expected = join(homeRoot(), "config.json");
      assert.equal(settingsConfigPath(), expected);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolved settings expose all six groups with defaults filled", () => {
  const home = tempHome();
  try {
    withHome(home, () => {
      const settings = resolveSettings();
      assert.deepEqual(settings.agents, {
        maxAgentDepth: 4,
        maxConcurrency: 2,
        maxParallelAgents: 3,
        retainedTerminalJobs: 25,
        retainedTerminalAgents: 25,
      });
      assert.deepEqual(settings.runtime, {
        deliveryRetryDelayMs: 2000,
        gitTimeoutMs: 60_000,
        gitLockStaleMs: 30_000,
        gitLockAcquireTimeoutMs: 30_000,
        gitMaxBufferBytes: 16 * 1024 * 1024,
        contextCompactThresholdPercent: 80,
      });
      assert.deepEqual(settings.channels, {
        maxRootSessions: 200,
        lockStaleMs: 10_000,
        lockUpdateMs: 5_000,
        lockAcquireRetries: 0,
        maxTextLength: 4_000,
        pairingPendingTtlMs: 3_600_000,
        pairingPendingMax: 3,
        mediaPhotoMaxBytes: 10 * 1024 * 1024,
        mediaDocumentMaxBytes: 50 * 1024 * 1024,
        mediaTimeoutMs: 30_000,
      });
      assert.deepEqual(settings.tools.web, {
        provider: "exa",
        searchTimeoutMs: 30_000,
        fetchTimeoutSeconds: 30,
        maxResponseBytes: 5 * 1024 * 1024,
        defaultNumResults: 5,
        defaultSearchType: "auto",
        defaultLivecrawl: "fallback",
      });
      assert.deepEqual(settings.mcp, {
        startupTimeoutMs: 30_000,
        requestTimeoutMs: 30_000,
        reconnectMaxAttempts: 5,
        reconnectBaseDelayMs: 2_000,
        resultMaxText: 50_000,
        resultMaxAttachmentBytes: 5 * 1024 * 1024,
        oauthCallbackTimeoutMs: 5 * 60 * 1000,
      });
      assert.deepEqual(settings.commands, {
        telegram: { reactionTimeoutMs: 2_500 },
        goalMaxPromptLength: 10_000,
      });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("home config overrides defaults per known field and applies bounds validation", () => {
  const home = tempHome();
  try {
    writeHomeConfig(home, {
      agents: { maxConcurrency: 7, maxParallelAgents: 9 },
      channels: { maxTextLength: 8000 },
    });
    withHome(home, () => {
      const settings = resolveSettings();
      assert.equal(settings.agents.maxConcurrency, 7);
      assert.equal(settings.agents.maxParallelAgents, 9);
      assert.equal(settings.channels.maxTextLength, 8000);
      // Unrelated defaults remain.
      assert.equal(settings.agents.maxAgentDepth, 4);
      assert.equal(settings.mcp.startupTimeoutMs, 30_000);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("precedence is env alias > project config > home config > default per field", () => {
  const home = tempHome();
  const project = mkdtempSync(join(tmpdir(), "pi-c2-settings-project-"));
  const previousEnv = process.env.PI_C2_MAX_AGENT_DEPTH;
  try {
    writeHomeConfig(home, { agents: { maxAgentDepth: 2, maxConcurrency: 5 } });
    writeProjectConfig(project, { agents: { maxAgentDepth: 3, maxConcurrency: 6 } });
    process.env.PI_C2_MAX_AGENT_DEPTH = "8";
    withHome(home, () => {
      const settings = resolveSettingsForProject(project);
      assert.equal(settings.agents.maxAgentDepth, 8, "env alias wins");
      assert.equal(settings.agents.maxConcurrency, 6, "project wins over home");
      assert.equal(settings.channels.maxRootSessions, 200, "default remains");
    });
  } finally {
    if (previousEnv === undefined) delete process.env.PI_C2_MAX_AGENT_DEPTH;
    else process.env.PI_C2_MAX_AGENT_DEPTH = previousEnv;
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("an invalid higher-precedence field falls through without erasing sibling fields", () => {
  const home = tempHome();
  const project = mkdtempSync(join(tmpdir(), "pi-c2-settings-project-"));
  try {
    writeHomeConfig(home, { agents: { maxConcurrency: 4, maxParallelAgents: 3 }, channels: { maxTextLength: 5000 } });
    // Project provides a valid maxParallelAgents and an invalid maxConcurrency.
    writeProjectConfig(project, { agents: { maxConcurrency: -1, maxParallelAgents: 9 } });
    withHome(home, () => {
      const settings = resolveSettingsForProject(project);
      assert.equal(settings.agents.maxConcurrency, 4, "invalid project value falls through to home");
      assert.equal(settings.agents.maxParallelAgents, 9, "valid sibling project value remains");
      assert.equal(settings.channels.maxTextLength, 5000, "home value remains for untouched group");
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("a malformed home config degrades to empty rather than throwing", () => {
  const home = tempHome();
  try {
    const dir = join(home, "pi-c2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{ not valid json !!!");
    withHome(home, () => {
      const settings = resolveSettings();
      assert.equal(settings.agents.maxAgentDepth, 4);
      assert.equal(settings.mcp.startupTimeoutMs, 30_000);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("unknown top-level and nested keys are absent from resolved settings", () => {
  const home = tempHome();
  try {
    writeHomeConfig(home, {
      unknownTopLevel: "ignored",
      agents: { maxConcurrency: 6, unknownAgentKey: "ignored" },
      tools: { unknownToolGroup: { enabled: true }, web: { unknownWebKey: "ignored" } },
      mcp: { unknownMcpKey: true },
    });
    withHome(home, () => {
      const settings = resolveSettings() as unknown as Record<string, unknown>;
      assert.equal(settings.unknownTopLevel, undefined);
      assert.equal((settings.agents as Record<string, unknown>).unknownAgentKey, undefined);
      assert.equal((settings.tools as Record<string, unknown>).unknownToolGroup, undefined);
      assert.equal((settings.tools as Record<string, unknown>).web && ((settings.tools as Record<string, unknown>).web as Record<string, unknown>).unknownWebKey, undefined);
      assert.equal((settings.mcp as Record<string, unknown>).unknownMcpKey, undefined);
      assert.equal((settings.agents as Record<string, unknown>).maxConcurrency, 6);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a non-object config supplies no valid fields", () => {
  const home = tempHome();
  try {
    writeHomeConfig(home, [1, 2, 3]);
    withHome(home, () => {
      const settings = resolveSettings();
      assert.equal(settings.agents.maxAgentDepth, 4);
      assert.equal(settings.channels.maxTextLength, 4_000);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("rewriting with an equal-length different value is observed without restart", () => {
  const home = tempHome();
  try {
    const file = join(home, "pi-c2", "config.json");
    mkdirSync(join(home, "pi-c2"), { recursive: true });
    // Both values serialize to the same byte length ("1" vs "9") so the
    // fingerprint must observe the write rather than only the size.
    writeFileSync(file, JSON.stringify({ agents: { maxConcurrency: 1 } }));
    withHome(home, () => {
      assert.equal(resolveSettings().agents.maxConcurrency, 1);
      writeFileSync(file, JSON.stringify({ agents: { maxConcurrency: 9 } }));
      assert.equal(resolveSettings().agents.maxConcurrency, 9, "next call observes the rewrite");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("removing the home config falls through to defaults", () => {
  const home = tempHome();
  try {
    writeHomeConfig(home, { agents: { maxConcurrency: 7 } });
    withHome(home, () => {
      assert.equal(resolveSettings().agents.maxConcurrency, 7);
      const file = join(home, "pi-c2", "config.json");
      rmSync(file, { force: true });
      assert.equal(resolveSettings().agents.maxConcurrency, 2, "default after removal");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the Exa credential is reachable from settings but absent from errors, diagnostics, and cache identity", () => {
  const home = tempHome();
  try {
    const secret = "exa-secret-do-not-leak-abcdef123456";
    writeHomeConfig(home, { tools: { web: { exaApiKey: secret } } });
    withHome(home, () => {
      const settings = resolveSettings();
      assert.equal(settings.tools.web.exaApiKey, secret);
      const global = globalThis as unknown as { __piC2SettingsDebug__?: { keys: string } };
      const keys = global.__piC2SettingsDebug__?.keys ?? "";
      assert.ok(!keys.includes(secret), "secret must not appear in settings-cache keys");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolution error paths do not surface the parsed secret", () => {
  const home = tempHome();
  const homeDir = join(home, "pi-c2");
  mkdirSync(homeDir, { recursive: true });
  try {
    const secret = "exa-secret-malformed-path-123456";
    // Malformed JSON containing the secret: the resolver must degrade to an
    // empty source and neither throw a message nor resolve the raw secret.
    writeFileSync(join(homeDir, "config.json"), `{ \"tools\": { \"web\": { \"exaApiKey\": \"${secret}\" } }, trailing`);
    withHome(home, () => {
      let threw = false;
      let message = "";
      try {
        const settings = resolveSettings();
        assert.equal(settings.tools.web.exaApiKey, undefined, "malformed file must not yield a raw secret");
      } catch (error) {
        threw = true;
        message = error instanceof Error ? error.message : String(error);
      }
      assert.equal(threw, false, "malformed settings must degrade, not throw");
      assert.ok(!message.includes(secret), "error text must not contain the secret");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("agents.model is resolved exactly as configured and never normalized", () => {
  const home = tempHome();
  try {
    writeHomeConfig(home, { agents: { model: "commandcode/meta/muse-spark-1.2-contributor" } });
    withHome(home, () => {
      assert.equal(resolveSettings().agents.model, "commandcode/meta/muse-spark-1.2-contributor");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("agents.model is absent by default and empty values are skipped", () => {
  const home = tempHome();
  try {
    writeHomeConfig(home, { agents: { model: "   " } });
    withHome(home, () => {
      assert.equal(resolveSettings().agents.model, undefined, "whitespace-only is treated as unset");
    });
    writeHomeConfig(home, { agents: { model: "" } });
    withHome(home, () => {
      assert.equal(resolveSettings().agents.model, undefined, "empty string is treated as unset");
    });
    rmSync(join(home, "pi-c2", "config.json"), { force: true });
    withHome(home, () => {
      assert.equal(resolveSettings().agents.model, undefined, "absent key stays absent");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("agents.model is never validated or auto-corrected even when unresolvable-looking", () => {
  const home = tempHome();
  try {
    // A value that no catalog could ever match must still be accepted as-is:
    // resolution happens later at child spawn, and errors surface to the user.
    writeHomeConfig(home, { agents: { model: "commandcode/definitely/not/a/real/model" } });
    withHome(home, () => {
      assert.equal(resolveSettings().agents.model, "commandcode/definitely/not/a/real/model");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("agents.model accepts a project override with home as the base", () => {
  const home = tempHome();
  const project = mkdtempSync(join(tmpdir(), "pi-c2-settings-model-project-"));
  try {
    writeHomeConfig(home, { agents: { model: "anthropic/claude-sonnet-4-5" } });
    writeProjectConfig(project, { agents: { model: "openai/gpt-5" } });
    withHome(home, () => {
      assert.equal(resolveSettingsForProject(project).agents.model, "openai/gpt-5", "project override wins");
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("agents.thinking is resolved exactly as configured and never normalized", () => {
  const home = tempHome();
  try {
    writeHomeConfig(home, { agents: { thinking: "high" } });
    withHome(home, () => {
      assert.equal(resolveSettings().agents.thinking, "high");
    });
    writeHomeConfig(home, { agents: { thinking: "not-a-level" } });
    withHome(home, () => {
      assert.equal(resolveSettings().agents.thinking, "not-a-level", "no validation of the config value");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("agents.thinking is absent by default and empty values are skipped", () => {
  const home = tempHome();
  try {
    writeHomeConfig(home, { agents: { thinking: "   " } });
    withHome(home, () => {
      assert.equal(resolveSettings().agents.thinking, undefined, "whitespace-only is treated as unset");
    });
    writeHomeConfig(home, { agents: { thinking: "" } });
    withHome(home, () => {
      assert.equal(resolveSettings().agents.thinking, undefined, "empty string is treated as unset");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("configured maxConcurrency is used when a project pool is constructed", async () => {
  const home = tempHome();
  const project = mkdtempSync(join(tmpdir(), "pi-c2-settings-concurrency-project-"));
  const previousHome = process.env.PI_C2_TEST_HOME;
  try {
    process.env.PI_C2_TEST_HOME = home;
    writeHomeConfig(home, { agents: { maxConcurrency: 4 } });
    const pool = getChildPool(project, "phase3-root");
    const releases = Array.from({ length: 4 }, () => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => { release = resolve; });
      return { promise, release };
    });
    const runs = releases.map(({ promise }) => pool.concurrency.run(() => promise));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(pool.concurrency.activeCount, 4);
    assert.equal(pool.concurrency.queuedCount, 0);
    for (const item of releases) item.release();
    await Promise.all(runs);
  } finally {
    if (previousHome === undefined) delete process.env.PI_C2_TEST_HOME;
    else process.env.PI_C2_TEST_HOME = previousHome;
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("configured terminal retention caps are applied to both registry implementations", () => {
  const home = tempHome();
  const project = mkdtempSync(join(tmpdir(), "pi-c2-settings-retention-project-"));
  const directPath = join(project, "jobs.jsonl");
  try {
    process.env.PI_C2_TEST_HOME = home;
    writeHomeConfig(home, { agents: { retainedTerminalJobs: 2, retainedTerminalAgents: 2 } });

    const direct = createRegistry(directPath);
    for (let index = 0; index < 3; index += 1) {
      direct.createJob(createJob({
        jobId: `direct-${index}`,
        status: "completed",
        description: `direct-${index}`,
        subagentType: "test-agent",
        createdAt: `2026-01-01T00:00:0${index}.000Z`,
      }));
    }
    assert.equal(direct.all().size, 2);
    assert.equal(direct.get("direct-0"), undefined);

    const scoped = createAgentEventRegistry(project, "phase3-root");
    for (let index = 0; index < 3; index += 1) {
      scoped.createJob(createJob({
        jobId: `agent-${index}`,
        parentSessionId: "phase3-root",
        sessionId: `agent-${index}`,
        status: "completed",
        description: `agent-${index}`,
        subagentType: "test-agent",
        createdAt: `2026-01-01T00:00:0${index}.000Z`,
      }));
    }
    assert.equal(scoped.all().size, 2);
    assert.equal(scoped.get("agent-0"), undefined);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("a rewritten concurrency config is honored on the next pool construction while the existing gate is not resized", async () => {
  const home = tempHome();
  const project = mkdtempSync(join(tmpdir(), "pi-c2-settings-reload-pool-project-"));
  const previousHome = process.env.PI_C2_TEST_HOME;
  try {
    process.env.PI_C2_TEST_HOME = home;
    const configFile = join(home, "pi-c2", "config.json");
    mkdirSync(join(home, "pi-c2"), { recursive: true });
    writeFileSync(configFile, JSON.stringify({ agents: { maxConcurrency: 2 } }));

    const first = getChildPool(project, "phase3-reload-root");
    const holds = Array.from({ length: 2 }, () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => { resolve = r; });
      return { promise, resolve };
    });
    const runs = holds.map(({ promise }) => first.concurrency.run(() => promise));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(first.concurrency.activeCount, 2, "original cap 2 admitted two slots");

    writeFileSync(configFile, JSON.stringify({ agents: { maxConcurrency: 5 } }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(first.concurrency.activeCount, 2, "the already-created gate is not retroactively resized");
    for (const item of holds) item.resolve();
    await Promise.all(runs);

    const projectB = mkdtempSync(join(tmpdir(), "pi-c2-settings-reload-pool-b-"));
    try {
      const second = getChildPool(projectB, "phase3-reload-root");
      const held = Array.from({ length: 5 }, () => {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => { resolve = r; });
        return { promise, resolve };
      });
      const newRuns = held.map(({ promise }) => second.concurrency.run(() => promise));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(second.concurrency.activeCount, 5, "new pool honors the rewritten cap 5");
      for (const item of held) item.resolve();
      await Promise.all(newRuns);
    } finally {
      rmSync(projectB, { recursive: true, force: true });
    }
  } finally {
    if (previousHome === undefined) delete process.env.PI_C2_TEST_HOME;
    else process.env.PI_C2_TEST_HOME = previousHome;
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("a rewritten retention config is honored on the next prune without restarting", () => {
  const home = tempHome();
  const project = mkdtempSync(join(tmpdir(), "pi-c2-settings-reload-prune-project-"));
  const directPath = join(project, "jobs.jsonl");
  const configFile = join(home, "pi-c2", "config.json");
  try {
    process.env.PI_C2_TEST_HOME = home;
    mkdirSync(join(home, "pi-c2"), { recursive: true });
    writeFileSync(configFile, JSON.stringify({ agents: { retainedTerminalJobs: 3 } }));

    const registry = createRegistry(directPath, project);
    for (let index = 0; index < 3; index += 1) {
      registry.createJob(createJob({
        jobId: `reload-${index}`,
        status: "completed",
        description: `reload-${index}`,
        subagentType: "test-agent",
        createdAt: `2026-01-01T00:00:0${index}.000Z`,
      }));
    }
    assert.equal(registry.all().size, 3, "initial cap 3 retains all three terminal jobs");

    writeFileSync(configFile, JSON.stringify({ agents: { retainedTerminalJobs: 1 } }));
    registry.prune();
    assert.equal(registry.all().size, 1, "the next prune observes the rewritten cap 1");
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("invalid agent/runtime values are ignored per-field rather than accepted", () => {
  const home = tempHome();
  try {
    writeHomeConfig(home, {
      agents: { maxConcurrency: 0, maxAgentDepth: -5, retainedTerminalJobs: 1000000 },
      runtime: { gitMaxBufferBytes: -1 },
    });
    withHome(home, () => {
      const settings = resolveSettings();
      assert.equal(settings.agents.maxConcurrency, 2);
      assert.equal(settings.agents.maxAgentDepth, 4);
      assert.equal(settings.agents.retainedTerminalJobs, 25);
      assert.equal(settings.runtime.gitMaxBufferBytes, 16 * 1024 * 1024);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("contextCompactThresholdPercent defaults to 80 and accepts 1-100", () => {
  const home = tempHome();
  try {
    withHome(home, () => {
      assert.equal(resolveSettings().runtime.contextCompactThresholdPercent, 80, "default 80");
    });
    writeHomeConfig(home, { runtime: { contextCompactThresholdPercent: 65 } });
    withHome(home, () => {
      assert.equal(resolveSettings().runtime.contextCompactThresholdPercent, 65, "home config override");
    });
    writeHomeConfig(home, { runtime: { contextCompactThresholdPercent: 1 } });
    withHome(home, () => {
      assert.equal(resolveSettings().runtime.contextCompactThresholdPercent, 1, "lower bound 1 accepted");
    });
    writeHomeConfig(home, { runtime: { contextCompactThresholdPercent: 100 } });
    withHome(home, () => {
      assert.equal(resolveSettings().runtime.contextCompactThresholdPercent, 100, "upper bound 100 accepted");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("contextCompactThresholdPercent rejects out-of-range and non-integer values", () => {
  const home = tempHome();
  try {
    const cases = [0, -1, 101, 1.5, "80", null];
    for (const value of cases) {
      writeHomeConfig(home, { runtime: { contextCompactThresholdPercent: value } });
      withHome(home, () => {
        assert.equal(resolveSettings().runtime.contextCompactThresholdPercent, 80, `invalid ${JSON.stringify(value)} falls back to default`);
      });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
