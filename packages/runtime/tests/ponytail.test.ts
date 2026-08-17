import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  clearSettingsCache,
  homePonytailStateFile,
  homePonytailSessionDir,
  loadPonytailState,
  mutatePonytailState,
  resolveSettingsForProject,
  serializePonytailMutation,
  startRootSession,
  initializeChildPonytailState,
  writePonytailState,
  type PonytailPersistence,
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

test("child Ponytail state inherits only enabled status and never root tickets", () => {
  const home = tempHome();
  const project = tempProject();
  mkdirSync(join(project, "src"));
  try {
    withHome(home, () => {
      writePonytailState("root-child-state", {
        version: 1,
        enabled: true,
        tickets: [{ value: "root-secret", scopes: [join(project, "src")], createdAt: 1, expiresAt: 10_000 }],
      });
      assert.equal(initializeChildPonytailState("root-child-state", "child-state", 2_000), true);
      assert.deepEqual(loadPonytailState("child-state", 2_000), { version: 1, enabled: true, tickets: [] });

      writePonytailState("root-disabled-child", { version: 1, enabled: false, tickets: [] });
      assert.equal(initializeChildPonytailState("root-disabled-child", "child-disabled", 2_000), false);
      assert.deepEqual(loadPonytailState("child-disabled", 2_000), { version: 1, enabled: false, tickets: [] });
      assert.equal(initializeChildPonytailState("missing-root", "child-missing", 2_000), false);
      assert.equal(existsSync(homePonytailStateFile("child-missing")), false);
    });
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); }
});

test("child resume preserves its own tickets and observes root enablement only at the boundary", () => {
  const home = tempHome(); const project = tempProject(); mkdirSync(join(project, "child"));
  try {
    withHome(home, () => {
      const childScope = realpathSync(join(project, "child"));
      writePonytailState("root-boundary", { version: 1, enabled: true, tickets: [] });
      assert.equal(initializeChildPonytailState("root-boundary", "child-boundary", 1_000), true);
      writePonytailState("child-boundary", {
        version: 1,
        enabled: true,
        tickets: [{ value: "child-ticket", scopes: [childScope], createdAt: 1, expiresAt: 10_000 }],
      });

      // A root toggle does not mutate an already-running child's persisted state.
      writePonytailState("root-boundary", { version: 1, enabled: false, tickets: [] });
      assert.deepEqual(loadPonytailState("child-boundary", 2_000), {
        version: 1,
        enabled: true,
        tickets: [{ value: "child-ticket", scopes: [childScope], createdAt: 1, expiresAt: 10_000 }],
      });

      // The next child start/resume boundary adopts the root bit but keeps the child ticket.
      assert.equal(initializeChildPonytailState("root-boundary", "child-boundary", 3_000), false);
      assert.deepEqual(loadPonytailState("child-boundary", 3_000), {
        version: 1,
        enabled: false,
        tickets: [{ value: "child-ticket", scopes: [childScope], createdAt: 1, expiresAt: 10_000 }],
      });
    });
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); }
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
      chmodSync(statePath, 0o644);
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
      assert.equal(statSync(`${statePath.slice(0, -"ponytail.json".length)}ponytail.002.json.bak`).mode & 0o777, 0o600);
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

test("backup permission failure restores the corrupt primary and stays inactive", () => {
  const home = tempHome();
  try {
    withHome(home, () => {
      const sessionId = "root-chmod-fail";
      const statePath = homePonytailStateFile(sessionId);
      writePonytailState(sessionId, { version: 1, enabled: true, tickets: [] });
      writeFileSync(statePath, "{broken", "utf8");
      const backupPath = join(homePonytailSessionDir(sessionId), "ponytail.001.json.bak");
      const persistence: PonytailPersistence = {
        readJson: (path) => JSON.parse(readFileSync(path, "utf8")),
        writeJson: (path, value) => writeFileSync(path, JSON.stringify(value)),
        rename: (from, to) => renameSync(from, to),
        list: (directory) => readdirSync(directory),
        exists: (path) => existsSync(path),
        chmod: () => { throw new Error("permission denied"); },
      };
      assert.equal(loadPonytailState(sessionId, 5_000, persistence), undefined);
      assert.equal(readFileSync(statePath, "utf8"), "{broken");
      assert.equal(existsSync(backupPath), false);
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

function malformedStateTicket(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    version: 1,
    enabled: true,
    tickets: [{ value: "t", scopes: ["/project/src"], createdAt: 1_000, expiresAt: 10_000, ...overrides }],
  });
}

for (const [label, mutate] of [
  ["traversal scope", () => ({ scopes: ["/project/../outside"] })],
  ["redundant-segment scope", () => ({ scopes: ["/project/src/../src"] })],
  ["empty scope list", () => ({ scopes: [] })],
  ["non-absolute scope", () => ({ scopes: ["project/src"] })],
  ["expired-before-created", () => ({ createdAt: 10_000, expiresAt: 1_000 })],
  ["negative timestamp", () => ({ createdAt: -5, expiresAt: 10_000 })],
  ["equal timestamps", () => ({ createdAt: 10_000, expiresAt: 10_000 })],
] as Array<[string, () => Record<string, unknown>]>) {
  test(`malformed ticket state is rejected and replaced: ${label}`, () => {
    const home = tempHome();
    try {
      withHome(home, () => {
        const statePath = homePonytailStateFile(`root-${label.replace(/[^a-z0-9]+/gi, "-")}`);
        writePonytailState(`root-${label.replace(/[^a-z0-9]+/gi, "-")}`, { version: 1, enabled: true, tickets: [] });
        writeFileSync(statePath, malformedStateTicket(mutate()));
        assert.deepEqual(loadPonytailState(`root-${label.replace(/[^a-z0-9]+/gi, "-")}`, 5_000), { version: 1, enabled: true, tickets: [] });
        assert.equal(readdirSync(join(home, "pi-c2", "sessions", `root-${label.replace(/[^a-z0-9]+/gi, "-")}`)).filter((name) => name.endsWith(".json.bak")).length, 1);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("existing file scopes are rejected as non-directory authorization scopes", () => {
  const home = tempHome();
  const project = tempProject();
  try {
    withHome(home, () => {
      const file = join(project, "file.txt");
      writeFileSync(file, "content");
      const sessionId = "root-file-scope";
      writePonytailState(sessionId, { version: 1, enabled: true, tickets: [] });
      writeFileSync(homePonytailStateFile(sessionId), JSON.stringify({
        version: 1,
        enabled: true,
        tickets: [{ value: "t", scopes: [file], createdAt: 1, expiresAt: 10_000 }],
      }));
      assert.deepEqual(loadPonytailState(sessionId, 5_000), { version: 1, enabled: true, tickets: [] });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("same-session mutations are serialized without losing ordering", async () => {
  const order: string[] = [];
  const first = serializePonytailMutation("root-queue", async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push("first");
    return 1;
  });
  const second = serializePonytailMutation("root-queue", async () => {
    order.push("second");
    return 2;
  });
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ["first", "second"]);
});

test("concurrent state mutations retain independent records", async () => {
  const home = tempHome();
  const previous = process.env.PI_C2_TEST_HOME;
  process.env.PI_C2_TEST_HOME = home;
  clearSettingsCache();
  try {
    writePonytailState("root-concurrent", { version: 1, enabled: true, tickets: [] });
    await Promise.all([
      mutatePonytailState("root-concurrent", 1_000, (state) => ({
        version: 1,
        enabled: state?.enabled ?? true,
        tickets: [...(state?.tickets ?? []), { value: "one", scopes: ["/project/one"], createdAt: 1, expiresAt: 10_000 }],
      })),
      mutatePonytailState("root-concurrent", 1_000, (state) => ({
        version: 1,
        enabled: state?.enabled ?? true,
        tickets: [...(state?.tickets ?? []), { value: "two", scopes: ["/project/two"], createdAt: 1, expiresAt: 10_000 }],
      })),
    ]);
    assert.deepEqual(loadPonytailState("root-concurrent", 2_000)?.tickets.map((ticket) => ticket.value), ["one", "two"]);
  } finally {
    if (previous === undefined) delete process.env.PI_C2_TEST_HOME;
    else process.env.PI_C2_TEST_HOME = previous;
    clearSettingsCache();
    rmSync(home, { recursive: true, force: true });
  }
});

test("expired tickets are pruned and persisted during a valid-state load", () => {
  const home = tempHome();
  try {
    withHome(home, () => {
      const statePath = homePonytailStateFile("root-prune");
      writePonytailState("root-prune", { version: 1, enabled: true, tickets: [] });
      writeFileSync(statePath, JSON.stringify({
        version: 1,
        enabled: true,
        tickets: [
          { value: "alive", scopes: ["/project/src"], createdAt: 1_000, expiresAt: 10_000 },
          { value: "stale", scopes: ["/project/old"], createdAt: 1, expiresAt: 4_000 },
        ],
      }));
      const loaded = loadPonytailState("root-prune", 5_000);
      assert.deepEqual(loaded?.tickets.map((t) => t.value), ["alive"]);
      assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")).tickets.map((t: { value: string }) => t.value), ["alive"]);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ponytail state directories and files are owner-only with no temporary siblings", () => {
  const home = tempHome();
  try {
    withHome(home, () => {
      writePonytailState("root-modes", validState());
      const statePath = homePonytailStateFile("root-modes");
      assert.equal(statSync(statePath).mode & 0o777, 0o600);
      const sessionDir = homePonytailSessionDir("root-modes");
      assert.equal(statSync(sessionDir).mode & 0o777, 0o700);
      assert.deepEqual(readdirSync(sessionDir), ["ponytail.json"]);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("backup-slot exhaustion leaves the corrupt primary untouched and loads no state", () => {
  const home = tempHome();
  try {
    withHome(home, () => {
      const statePath = homePonytailStateFile("root-full");
      writePonytailState("root-full", { version: 1, enabled: true, tickets: [] });
      writeFileSync(statePath, "{broken");
      const sessionDir = homePonytailSessionDir("root-full");
      mkdirSync(sessionDir, { recursive: true });
      for (let number = 1; number <= 999; number += 1) {
        writeFileSync(join(sessionDir, `ponytail.${String(number).padStart(3, "0")}.json.bak`), "{}");
      }
      assert.equal(loadPonytailState("root-full", 5_000), undefined);
      assert.equal(readFileSync(statePath, "utf8"), "{broken");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("recovery publication failure restores the backup and loads no state", () => {
  const home = tempHome();
  try {
    withHome(home, () => {
      const statePath = homePonytailStateFile("root-write-fail");
      writePonytailState("root-write-fail", { version: 1, enabled: true, tickets: [] });
      writeFileSync(statePath, "{broken");
      const directory = homePonytailSessionDir("root-write-fail");
      const persistence: PonytailPersistence = {
        readJson: (path) => (path === statePath ? undefined : JSON.parse(readFileSync(path, "utf8"))),
        writeJson: () => { throw new Error("disk full"); },
        rename: (from, to) => renameSync(from, to),
        list: (dir) => readdirSync(dir),
        exists: (path) => existsSync(path),
        chmod: () => undefined,
      };
      assert.equal(loadPonytailState("root-write-fail", 5_000, persistence), undefined);
      assert.equal(existsSync(statePath), true);
      assert.equal(readFileSync(statePath, "utf8"), "{broken");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
