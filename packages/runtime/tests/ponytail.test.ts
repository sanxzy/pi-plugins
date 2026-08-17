import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  clearSettingsCache,
  homePonytailStateFile,
  loadPonytailState,
  resolveSettingsForProject,
  startRootSession,
  writePonytailState,
  type PonytailState,
} from "@xzy-ai/runtime";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "pi-c2-ponytail-home-"));
}

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "pi-c2-ponytail-project-"));
}

function withHome(home: string, run: () => void): void {
  const previous = process.env.PI_C2_TEST_HOME;
  process.env.PI_C2_TEST_HOME = home;
  clearSettingsCache();
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.PI_C2_TEST_HOME;
    else process.env.PI_C2_TEST_HOME = previous;
    clearSettingsCache();
  }
}

function writeConfig(home: string, value: unknown): void {
  mkdirSync(join(home, "pi-c2"), { recursive: true });
  writeFileSync(join(home, "pi-c2", "config.json"), JSON.stringify(value));
}

function validState(enabled = true): PonytailState {
  return {
    version: 1,
    enabled,
    tickets: [
      {
        value: "ticket-secret",
        scopes: ["/project/src"],
        createdAt: 1_000,
        expiresAt: 10_000,
      },
    ],
  };
}

test("home config exposes disabled Ponytail and bounded ticket TTL, ignoring project overrides", () => {
  const home = tempHome();
  const project = tempProject();
  try {
    withHome(home, () => {
      writeConfig(home, { tools: { ponytailEnabled: true, writeEditTicketTtlMs: 120_000 } });
      mkdirSync(join(project, ".pi"), { recursive: true });
      writeFileSync(join(project, ".pi", "pi-c2.json"), JSON.stringify({
        tools: { ponytailEnabled: false, writeEditTicketTtlMs: 3_600_000, web: { defaultNumResults: 7 } },
      }));
      assert.equal(resolveSettingsForProject(project).tools.ponytailEnabled, true);
      assert.equal(resolveSettingsForProject(project).tools.writeEditTicketTtlMs, 120_000);
      assert.equal(resolveSettingsForProject(project).tools.web.defaultNumResults, 7);

      writeConfig(home, { tools: { ponytailEnabled: "true", writeEditTicketTtlMs: 59_999 } });
      clearSettingsCache();
      assert.equal(resolveSettingsForProject(project).tools.ponytailEnabled, false);
      assert.equal(resolveSettingsForProject(project).tools.writeEditTicketTtlMs, 600_000);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("new root lifecycle materializes enabled Ponytail state and leaves disabled roots without state", () => {
  const home = tempHome();
  const enabledProject = tempProject();
  const disabledProject = tempProject();
  try {
    withHome(home, () => {
      writeConfig(home, { tools: { ponytailEnabled: true } });
      startRootSession({ projectRoot: enabledProject, sessionId: "root-enabled", now: "2026-01-01T00:00:00.000Z" });
      const enabledPath = homePonytailStateFile("root-enabled");
      assert.equal(existsSync(enabledPath), true);
      assert.deepEqual(JSON.parse(readFileSync(enabledPath, "utf8")), { version: 1, enabled: true, tickets: [] });

      writeConfig(home, { tools: { ponytailEnabled: false } });
      clearSettingsCache();
      startRootSession({ projectRoot: disabledProject, sessionId: "root-disabled", now: "2026-01-01T00:00:00.000Z" });
      assert.equal(existsSync(homePonytailStateFile("root-disabled")), false);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(enabledProject, { recursive: true, force: true });
    rmSync(disabledProject, { recursive: true, force: true });
  }
});

test("existing session state and unexpired tickets survive home changes and restart", () => {
  const home = tempHome();
  const project = tempProject();
  try {
    withHome(home, () => {
      writeConfig(home, { tools: { ponytailEnabled: true } });
      startRootSession({ projectRoot: project, sessionId: "root-persist", now: "2026-01-01T00:00:00.000Z" });
      const state = validState(true);
      writePonytailState("root-persist", state);
      writeConfig(home, { tools: { ponytailEnabled: false } });
      clearSettingsCache();
      startRootSession({ projectRoot: project, sessionId: "root-persist", now: "2026-01-02T00:00:00.000Z" });
      assert.deepEqual(loadPonytailState("root-persist", 5_000), state);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("malformed state is backed up and newest valid backup restores complete unexpired state", () => {
  const home = tempHome();
  try {
    withHome(home, () => {
      const statePath = homePonytailStateFile("root-recover");
      writePonytailState("root-recover", validState(false));
      writeFileSync(statePath, "{broken", "utf8");
      const backup = `${statePath.slice(0, -"ponytail.json".length)}ponytail.001.json.bak`;
      writeFileSync(backup, JSON.stringify({
        version: 1,
        enabled: true,
        tickets: [
          { value: "restored", scopes: ["/project/lib"], createdAt: 2_000, expiresAt: 20_000 },
          { value: "expired", scopes: ["/project/old"], createdAt: 1, expiresAt: 2 },
        ],
      }));
      const recovered = loadPonytailState("root-recover", 5_000);
      assert.deepEqual(recovered, {
        version: 1,
        enabled: true,
        tickets: [{ value: "restored", scopes: ["/project/lib"], createdAt: 2_000, expiresAt: 20_000 }],
      });
      assert.equal(existsSync(statePath), true);
      assert.equal(existsSync(`${statePath.slice(0, -"ponytail.json".length)}ponytail.002.json.bak`), true);
      assert.deepEqual(readdirSync(join(home, "pi-c2", "sessions", "root-recover")).sort(), [
        "ponytail.001.json.bak",
        "ponytail.002.json.bak",
        "ponytail.json",
      ]);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("invalid state never loads as active authorization", () => {
  const home = tempHome();
  try {
    withHome(home, () => {
      const statePath = homePonytailStateFile("root-invalid");
      writePonytailState("root-invalid", validState());
      writeFileSync(statePath, JSON.stringify({ version: 2, enabled: true, tickets: [] }));
      assert.deepEqual(loadPonytailState("root-invalid", 5_000), { version: 1, enabled: true, tickets: [] });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
