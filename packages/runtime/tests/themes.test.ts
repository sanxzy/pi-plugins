import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  BUILTIN_THEME_PROFILES,
  THEMES_BACKUP_PREFIX,
  THEMES_BACKUP_SUFFIX,
  THEMES_FILE_NAME,
  clearThemeLibraryCache,
  createThemeAssignmentCursor,
  getBuiltinThemeFallback,
  getThemeProfile,
  homeThemesFile,
  loadThemeLibrary,
  readThemeLibrary,
  validateThemeLibrary,
  type ThemeLibrary,
  type ThemeLibraryPersistence,
} from "@xzy-ai/runtime";

function withHome<T>(run: () => T): T {
  const previousHome = process.env.PI_C2_HOME;
  const previousTestHome = process.env.PI_C2_TEST_HOME;
  const home = mkdtempSync(join(tmpdir(), "pi-c2-themes-home-"));
  process.env.PI_C2_TEST_HOME = home;
  clearThemeLibraryCache();
  try {
    return run();
  } finally {
    clearThemeLibraryCache();
    if (previousTestHome === undefined) delete process.env.PI_C2_TEST_HOME;
    else process.env.PI_C2_TEST_HOME = previousTestHome;
    if (previousHome === undefined) delete process.env.PI_C2_HOME;
    else process.env.PI_C2_HOME = previousHome;
  }
}

function backupPath(number: number): string {
  const file = homeThemesFile();
  return join(dirname(file), `${THEMES_BACKUP_PREFIX}${String(number).padStart(3, "0")}${THEMES_BACKUP_SUFFIX}`);
}

function mutableBuiltins(): ThemeLibrary {
  return structuredClone({ version: 1, profiles: BUILTIN_THEME_PROFILES }) as ThemeLibrary;
}

function writeRaw(value: unknown): void {
  const file = homeThemesFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

test("theme library", async (t) => {
  await t.test("the embedded library ships at least ten distinct dark built-in themes", () => withHome(() => {
    assert.ok(BUILTIN_THEME_PROFILES.length >= 10);
    const ids = BUILTIN_THEME_PROFILES.map((profile) => profile.themeId);
    assert.equal(new Set(ids).size, ids.length, "built-in theme ids must be unique");
    assert.equal(ids.includes("light"), false, "no light theme ships by default");
    assert.ok(ids.includes("dark"));
    assert.ok(ids.includes("atom-dark"));
    assert.ok(ids.includes("monokai"));
    assert.ok(ids.includes("dracula"));
    for (const profile of BUILTIN_THEME_PROFILES) {
      assert.notEqual(validateThemeLibrary({ version: 1, profiles: [structuredClone(profile)] }), undefined, `${profile.themeId} must validate`);
      // Every built-in is a dark theme: light text over dark backgrounds.
      assert.match(String(profile.export?.pageBg ?? ""), /^#[0-9a-f]{6}$/);
    }
  }));

  await t.test("built-in accents never render near-white outside text roles", () => {
    const textRoles = new Set(["text", "searchMatchText", "userMessageText", "customMessageText", "toolTitle"]);
    const luminance = (hex: string): number => {
      const channel = (index: number): number => Number.parseInt(hex.replace("#", "").slice(index, index + 2), 16) / 255;
      const adjust = (channelValue: number): number => (channelValue <= 0.03928 ? channelValue / 12.92 : ((channelValue + 0.055) / 1.055) ** 2.4);
      return 0.2126 * adjust(channel(0)) + 0.7152 * adjust(channel(2)) + 0.0722 * adjust(channel(4));
    };
    const resolve = (value: unknown, vars: Record<string, unknown>, seen = new Set<string>()): unknown => {
      if (typeof value !== "string" || value === "" || value.startsWith("#")) return value;
      if (seen.has(value)) return undefined;
      seen.add(value);
      const next = vars[value];
      return next === undefined ? undefined : resolve(next, vars, seen);
    };
    const offenders: string[] = [];
    for (const profile of BUILTIN_THEME_PROFILES) {
      for (const [token, raw] of Object.entries(profile.colors)) {
        if (textRoles.has(token)) continue;
        const resolved = resolve(raw, profile.vars);
        if (typeof resolved === "string" && resolved.startsWith("#") && luminance(resolved) >= 0.78) {
          offenders.push(`${profile.themeId}.${token} -> ${resolved}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  await t.test("user message surfaces stay clearly lighter than tool surfaces", () => {
    const luminance = (hex: string): number => {
      const channel = (index: number): number => Number.parseInt(hex.replace("#", "").slice(index, index + 2), 16) / 255;
      const adjust = (channelValue: number): number => (channelValue <= 0.03928 ? channelValue / 12.92 : ((channelValue + 0.055) / 1.055) ** 2.4);
      return 0.2126 * adjust(channel(0)) + 0.7152 * adjust(channel(2)) + 0.0722 * adjust(channel(4));
    };
    const resolve = (vars: Record<string, unknown>, value: unknown, seen = new Set<string>()): unknown => {
      if (typeof value !== "string" || value === "" || value.startsWith("#")) return value;
      if (seen.has(value)) return undefined;
      seen.add(value);
      const next = vars[value];
      return next === undefined ? undefined : resolve(vars, next, seen);
    };
    const offenders: string[] = [];
    for (const profile of BUILTIN_THEME_PROFILES) {
      const userBg = String(resolve(profile.vars as Record<string, unknown>, profile.colors.userMessageBg));
      const pendingBg = String(resolve(profile.vars as Record<string, unknown>, profile.colors.toolPendingBg));
      if (userBg === pendingBg) offenders.push(`${profile.themeId}: userMessageBg equals toolPendingBg`);
      else if (luminance(userBg) <= luminance(pendingBg)) offenders.push(`${profile.themeId}: userMessageBg must be lighter than toolPendingBg`);
      else if (luminance(userBg) - luminance(pendingBg) < 0.015) offenders.push(`${profile.themeId}: userMessageBg contrast too low (${(luminance(userBg) - luminance(pendingBg)).toFixed(3)})`);
    }
    assert.deepEqual(offenders, []);
  });

  await t.test("first use publishes the complete built-in library privately", () => withHome(() => {
    const library = loadThemeLibrary();
    assert.equal(library.version, 1);
    assert.deepEqual(library.profiles.map((profile) => profile.themeId), Array.from(BUILTIN_THEME_PROFILES.map((profile) => profile.themeId)));
    assert.deepEqual(library.profiles, BUILTIN_THEME_PROFILES);
    assert.equal(homeThemesFile().endsWith(THEMES_FILE_NAME), true);
    assert.equal(statSync(homeThemesFile()).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(homeThemesFile())).mode & 0o777, 0o700);
    const entries = readdirSync(dirname(homeThemesFile()));
    assert.equal(entries.includes(THEMES_FILE_NAME), true);
    assert.equal(entries.filter((entry) => entry.startsWith("themes.")).length, 1);
    for (const profile of library.profiles) {
      assert.equal(profile.themeId.includes("/"), false);
      assert.equal(profile.colors.accent !== undefined, true);
      assert.equal(profile.colors.bashMode !== undefined, true);
      assert.equal(profile.colors.thinkingMax !== undefined, true);
      assert.equal(profile.colors.scrollbarThumb !== undefined, true);
      assert.equal(profile.colors.searchMatchBg !== undefined, true);
      assert.equal(profile.colors.searchMatchText !== undefined, true);
    }
  }));

  await t.test("valid external edits are detected without clearing the process cache", () => withHome(() => {
    const first = loadThemeLibrary();
    const changed = mutableBuiltins();
    changed.profiles[0]!.name = "Edited dark";
    changed.profiles[0]!.colors.accent = "#123456";
    writeRaw(changed);

    const reloaded = loadThemeLibrary();
    assert.equal(reloaded.profiles[0]!.name, "Edited dark");
    assert.equal(reloaded.profiles[0]!.colors.accent, "#123456");
    assert.notEqual(reloaded.profiles[0]!.name, first.profiles[0]!.name);

    writeRaw("{ malformed");
    const recovered = loadThemeLibrary();
    assert.equal(recovered.profiles[0]!.themeId, "dark");
    assert.equal(recovered.profiles[0]!.name, BUILTIN_THEME_PROFILES[0]!.name);
    assert.notEqual(recovered.profiles[0]!.name, "Edited dark");
  }));

  for (const [label, mutate] of [
    ["incomplete colors", (library: ThemeLibrary) => { Reflect.deleteProperty(library.profiles[0]!.colors, "accent"); }],
    ["invalid hex", (library: ThemeLibrary) => { library.profiles[0]!.colors.accent = "#not-hex"; }],
    ["unresolved variable", (library: ThemeLibrary) => { library.profiles[0]!.colors.accent = "missing-variable"; }],
    ["duplicate identity", (library: ThemeLibrary) => { library.profiles[1]!.themeId = library.profiles[0]!.themeId; }],
  ] as Array<[string, (library: ThemeLibrary) => void]>) {
    await t.test(`invalid library is backed up and regenerated: ${label}`, () => withHome(() => {
      loadThemeLibrary();
      const invalid = mutableBuiltins();
      mutate(invalid);
      writeRaw(invalid);

      const recovered = loadThemeLibrary();
      assert.deepEqual(recovered.profiles, BUILTIN_THEME_PROFILES);
      assert.equal(existsSync(backupPath(1)), true);
      assert.deepEqual(JSON.parse(readFileSync(backupPath(1), "utf8")), invalid);
      assert.equal(statSync(backupPath(1)).mode & 0o777, 0o600);
    }));
  }

  await t.test("backup numbering never overwrites invalid or valid recovery evidence", () => withHome(() => {
    loadThemeLibrary();
    const existingInvalid = "{old backup";
    mkdirSync(dirname(homeThemesFile()), { recursive: true });
    writeFileSync(backupPath(1), existingInvalid, "utf8");
    const existingValid = mutableBuiltins();
    existingValid.profiles[0]!.name = "recoverable backup";
    writeFileSync(backupPath(2), JSON.stringify(existingValid), "utf8");
    const malformedPrimary = "{broken primary";
    writeRaw(malformedPrimary);

    loadThemeLibrary();
    assert.equal(readFileSync(backupPath(1), "utf8"), existingInvalid);
    assert.deepEqual(JSON.parse(readFileSync(backupPath(2), "utf8")), existingValid);
    assert.equal(existsSync(backupPath(3)), true);
    assert.equal(readFileSync(backupPath(3), "utf8"), malformedPrimary);
  }));

  await t.test("recovery failures leave the original primary available and return in-memory built-ins", () => withHome(() => {
    loadThemeLibrary();
    const original = "{do not destroy";
    writeRaw(original);
    const file = homeThemesFile();
    const persistence: ThemeLibraryPersistence = {
      readJson: (path) => JSON.parse(readFileSync(path, "utf8")),
      writeJson: () => { throw new Error("disk full"); },
      rename: () => { throw new Error("rename denied"); },
      list: (directory) => readdirSync(directory),
      exists: (path) => existsSync(path),
      chmod: () => undefined,
    };

    const recovered = loadThemeLibrary(persistence);
    assert.deepEqual(recovered.profiles, BUILTIN_THEME_PROFILES);
    assert.equal(readFileSync(file, "utf8"), original);
  }));

  await t.test("existence and backup-list failures fail closed without replacing the primary", () => withHome(() => {
    loadThemeLibrary();
    const original = "{preserve this primary";
    writeRaw(original);
    const file = homeThemesFile();
    const basePersistence = {
      readJson: (path: string) => JSON.parse(readFileSync(path, "utf8")),
      writeJson: () => undefined,
      rename: (from: string, to: string) => renameSync(from, to),
      list: (directory: string) => readdirSync(directory),
      exists: (path: string) => existsSync(path),
      chmod: () => undefined,
    };

    const existenceFailure = loadThemeLibrary({
      ...basePersistence,
      exists: () => { throw new Error("probe denied"); },
    });
    assert.deepEqual(existenceFailure.profiles, BUILTIN_THEME_PROFILES);
    assert.equal(readFileSync(file, "utf8"), original);
    assert.equal(existsSync(backupPath(1)), false);

    const listingFailure = loadThemeLibrary({
      ...basePersistence,
      list: () => { throw new Error("listing denied"); },
    });
    assert.deepEqual(listingFailure.profiles, BUILTIN_THEME_PROFILES);
    assert.equal(readFileSync(file, "utf8"), original);
    assert.equal(existsSync(backupPath(1)), false);
  }));

  await t.test("a backup slot that appears after listing is never overwritten", () => withHome(() => {
    loadThemeLibrary();
    const original = "{preserve this collision";
    writeRaw(original);
    const file = homeThemesFile();
    const firstBackup = backupPath(1);
    writeFileSync(firstBackup, "existing evidence", "utf8");
    const persistence: ThemeLibraryPersistence = {
      readJson: (path) => JSON.parse(readFileSync(path, "utf8")),
      writeJson: () => undefined,
      rename: (from, to) => renameSync(from, to),
      list: () => ["themes.json"],
      exists: (path) => path === file || path === firstBackup,
      chmod: () => undefined,
    };

    const recovered = loadThemeLibrary(persistence);
    assert.deepEqual(recovered.profiles, BUILTIN_THEME_PROFILES);
    assert.equal(readFileSync(file, "utf8"), original);
    assert.equal(readFileSync(firstBackup, "utf8"), "existing evidence");
  }));

  await t.test("publication failure after backup restores the original primary", () => withHome(() => {
    loadThemeLibrary();
    const original = "{restore me";
    writeRaw(original);
    const file = homeThemesFile();
    let renameCount = 0;
    const persistence: ThemeLibraryPersistence = {
      readJson: (path) => JSON.parse(readFileSync(path, "utf8")),
      writeJson: () => { throw new Error("disk full"); },
      rename: (from, to) => {
        renameCount += 1;
        renameSync(from, to);
      },
      moveToBackup: (from, to) => {
        renameCount += 1;
        renameSync(from, to);
      },
      list: (directory) => readdirSync(directory),
      exists: (path) => existsSync(path),
      chmod: () => undefined,
    };

    const recovered = loadThemeLibrary(persistence);
    assert.deepEqual(recovered.profiles, BUILTIN_THEME_PROFILES);
    assert.equal(renameCount, 2);
    assert.equal(readFileSync(file, "utf8"), original);
    assert.equal(existsSync(backupPath(1)), false);
  }));

  await t.test("optional host export tokens validate without weakening the complete UI-token contract", () => withHome(() => {
    const library = mutableBuiltins();
    library.profiles[0]!.export = { pageBg: "#111111" };
    assert.ok(validateThemeLibrary(library));
    Object.assign(library.profiles[0]!.colors, { unknownToken: "#ffffff" });
    assert.equal(validateThemeLibrary(library), undefined);
  }));

  await t.test("round-robin assignment reuses profiles and resets with a new cursor", () => withHome(() => {
    const cursor = createThemeAssignmentCursor();
    assert.equal(cursor.nextThemeId(), BUILTIN_THEME_PROFILES[0]!.themeId);
    assert.equal(cursor.nextThemeId(), BUILTIN_THEME_PROFILES[1]!.themeId);
    assert.equal(cursor.nextThemeId(), BUILTIN_THEME_PROFILES[2]!.themeId);
    const restarted = createThemeAssignmentCursor();
    assert.equal(restarted.nextThemeId(), BUILTIN_THEME_PROFILES[0]!.themeId);
  }));

  await t.test("assignment avoids the parent-matching profile so fresh children stay visibly distinct", () => withHome(() => {
    const dark = BUILTIN_THEME_PROFILES[0]!.themeId;
    const other = BUILTIN_THEME_PROFILES[1]!.themeId;
    const cursor = createThemeAssignmentCursor();
    // Rotation lands on dark (the parent theme): it is skipped.
    const first = cursor.reserveThemeId(dark);
    assert.equal(first.themeId, other);
    first.commit();
    // Later rotations that land on the parent theme are skipped as well.
    const second = cursor.reserveThemeId(dark);
    assert.equal(second.themeId, other);
    second.commit();
    // Non-matching picks pass through unchanged.
    const third = cursor.reserveThemeId(other);
    assert.equal(third.themeId, BUILTIN_THEME_PROFILES[2]!.themeId);
    third.commit();
    // Without an avoid id the pure round-robin order is preserved.
    assert.equal(createThemeAssignmentCursor().nextThemeId(), dark);
    // A rollback never consumes a slot, including one reached via avoidance.
    const fresh = createThemeAssignmentCursor();
    const rolledBack = fresh.reserveThemeId(dark);
    assert.equal(rolledBack.themeId, other);
    rolledBack.rollback();
    assert.equal(fresh.reserveThemeId(dark).themeId, other);
  }));

  await t.test("a previously published library gains newly embedded built-ins without losing customizations", () => withHome(() => {
    const customized = structuredClone(BUILTIN_THEME_PROFILES[0]!);
    customized.name = "My Dark";
    writeRaw({ version: 1, profiles: [customized] });
    clearThemeLibraryCache();
    const loaded = loadThemeLibrary();
    const byId = new Map(loaded.profiles.map((profile) => [profile.themeId, profile]));
    assert.equal(byId.get("dark")?.name, "My Dark");
    assert.ok(byId.has("dracula"));
    assert.ok(byId.has("github-dark"));
    assert.ok(loaded.profiles.length >= BUILTIN_THEME_PROFILES.length);
    // The strict reader stays pure: merging happens only on load.
    assert.equal(readThemeLibrary(homeThemesFile()).profiles.length, 1);
  }));

  await t.test("profiles for removed built-ins are retired from persisted libraries on load", () => withHome(() => {
    // Libraries published before the light theme was removed keep carrying it;
    // loading must retire it so children can never be assigned white surfaces.
    const staleLight = structuredClone(BUILTIN_THEME_PROFILES[0]!);
    staleLight.themeId = "light";
    staleLight.name = "Light";
    writeRaw({ version: 1, profiles: [staleLight, structuredClone(BUILTIN_THEME_PROFILES[0]!)] });
    clearThemeLibraryCache();
    const loaded = loadThemeLibrary();
    assert.equal(loaded.profiles.some((profile) => profile.themeId === "light"), false);
    assert.ok(loaded.profiles.some((profile) => profile.themeId === "dark"));
    assert.ok(loaded.profiles.some((profile) => profile.themeId === "dracula"));
    // Resolution of an already-assigned legacy job falls back deterministically.
    assert.equal(getThemeProfile("light", loaded).themeId, getBuiltinThemeFallback().themeId);
  }));

  await t.test("lookup returns a defensive profile and deterministic built-in fallback", () => withHome(() => {
    const library = loadThemeLibrary();
    const dark = getThemeProfile("dark", library);
    assert.equal(dark.themeId, "dark");
    dark.colors.accent = "#ffffff";
    assert.equal(getThemeProfile("dark", library).colors.accent, BUILTIN_THEME_PROFILES[0]!.colors.accent);
    assert.equal(getThemeProfile("missing", library).themeId, getBuiltinThemeFallback().themeId);
    assert.equal(getThemeProfile(undefined, library).themeId, "dark");
    assert.equal(readThemeLibrary(homeThemesFile()).profiles.length, BUILTIN_THEME_PROFILES.length);
  }));
});
