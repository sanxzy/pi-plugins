import { existsSync, readdirSync, readFileSync, renameSync, statSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  THEMES_BACKUP_PREFIX,
  THEMES_BACKUP_SUFFIX,
  THEMES_FILE_NAME,
  homeThemesFile,
  readPrivateJson,
  writePrivateJson,
} from "../../shared/paths.ts";
import { BUILTIN_THEME_PROFILES, DEFAULT_THEME_ID } from "./builtins.ts";
import {
  THEME_BACKGROUND_TOKENS,
  THEME_COLOR_TOKENS,
  THEME_EXPORT_TOKENS,
  THEME_FOREGROUND_TOKENS,
  type ThemeColorMode,
  type ThemeColorValue,
  type ThemeLibrary,
  type ThemeProfile,
} from "./types.ts";

export { BUILTIN_THEME_IDS, BUILTIN_THEME_PROFILES, DEFAULT_THEME_ID } from "./builtins.ts";
export {
  THEME_BACKGROUND_TOKENS,
  THEME_COLOR_TOKENS,
  THEME_EXPORT_TOKENS,
  THEME_FOREGROUND_TOKENS,
  type ThemeColorMode,
  type ThemeColorValue,
  type ThemeColors,
  type ThemeExportColors,
  type ThemeExportToken,
  type ThemeForegroundToken,
  type ThemeBackgroundToken,
  type ThemeColorToken,
  type ThemeLibrary,
  type ThemeProfile,
  type ThemeVars,
} from "./types.ts";

const THEME_LIBRARY_VERSION = 1 as const;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})?$/;
const DISPLAY_NAME_MAX_LENGTH = 128;
const VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const BACKUP_PATTERN = /^themes\.\d{3}\.json\.bak$/;
const PROFILE_KEYS = new Set(["themeId", "name", "colorMode", "vars", "colors", "export"]);
const LIBRARY_KEYS = new Set(["version", "profiles"]);

/** Optional filesystem seam used to make recovery failures deterministic. */
export interface ThemeLibraryPersistence {
  readonly readJson: (filePath: string) => unknown;
  readonly writeJson: (filePath: string, value: unknown) => void;
  readonly rename: (from: string, to: string) => void;
  readonly list: (directory: string) => string[];
  readonly exists: (filePath: string) => boolean;
  readonly chmod: (filePath: string, mode: number) => void;
}

const defaultPersistence: ThemeLibraryPersistence = {
  readJson: (filePath) => readPrivateJson<unknown>(filePath),
  writeJson: (filePath, value) => writePrivateJson(filePath, value),
  rename: (from, to) => renameSync(from, to),
  list: (directory) => readdirSync(directory),
  exists: (filePath) => existsSync(filePath),
  chmod: (filePath, mode) => chmodSync(filePath, mode),
};

interface ThemeLibraryCache {
  readonly filePath: string;
  readonly fingerprint: string;
  readonly library: ThemeLibrary;
}

let cache: ThemeLibraryCache | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function isValidColorValue(value: unknown): value is ThemeColorValue {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 && value <= 255;
  if (typeof value !== "string") return false;
  if (value === "" || HEX_COLOR_PATTERN.test(value)) return true;
  return VARIABLE_PATTERN.test(value);
}

function resolveColorValue(value: ThemeColorValue, vars: Record<string, ThemeColorValue>, visiting: Set<string>): boolean {
  if (typeof value === "number" || value === "" || HEX_COLOR_PATTERN.test(value)) return true;
  if (!Object.prototype.hasOwnProperty.call(vars, value)) return false;
  if (visiting.has(value)) return false;
  visiting.add(value);
  const resolved = resolveColorValue(vars[value]!, vars, visiting);
  visiting.delete(value);
  return resolved;
}

function validateColorMap(
  raw: unknown,
  tokens: readonly string[],
  vars: Record<string, ThemeColorValue>,
  label: string,
): Record<string, ThemeColorValue> | undefined {
  if (!isRecord(raw)) return undefined;
  const tokenSet = new Set(tokens);
  if (Object.keys(raw).some((key) => !tokenSet.has(key))) return undefined;
  const result: Record<string, ThemeColorValue> = {};
  for (const token of tokens) {
    if (!Object.prototype.hasOwnProperty.call(raw, token)) return undefined;
    const value = raw[token];
    if (!isValidColorValue(value) || !resolveColorValue(value, vars, new Set())) return undefined;
    result[token] = value;
  }
  return result;
}

function validateVars(raw: unknown): Record<string, ThemeColorValue> | undefined {
  if (!isRecord(raw)) return undefined;
  const vars: Record<string, ThemeColorValue> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!VARIABLE_PATTERN.test(name) || !isValidColorValue(value)) return undefined;
    vars[name] = value;
  }
  for (const value of Object.values(vars)) {
    if (!resolveColorValue(value, vars, new Set())) return undefined;
  }
  return vars;
}

function validateProfile(raw: unknown): ThemeProfile | undefined {
  if (!isRecord(raw) || !hasOnlyKeys(raw, PROFILE_KEYS)) return undefined;
  const themeId = raw.themeId;
  const name = raw.name;
  const colorMode = raw.colorMode;
  if (typeof themeId !== "string" || !IDENTIFIER_PATTERN.test(themeId)) return undefined;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > DISPLAY_NAME_MAX_LENGTH ||
    name !== name.trim() ||
    name.includes("/") ||
    name.includes("\\")
  ) return undefined;
  if (colorMode !== "truecolor" && colorMode !== "256color") return undefined;
  const vars = validateVars(raw.vars);
  if (!vars) return undefined;
  const colors = validateColorMap(raw.colors, THEME_COLOR_TOKENS, vars, "colors");
  if (!colors) return undefined;
  let exportColors: Record<string, ThemeColorValue> | undefined;
  if (raw.export !== undefined) {
    exportColors = validateColorMap(raw.export, THEME_EXPORT_TOKENS, vars, "export");
    if (!exportColors) return undefined;
  }
  return {
    themeId,
    name,
    colorMode: colorMode as ThemeColorMode,
    vars,
    colors: colors as ThemeProfile["colors"],
    ...(exportColors === undefined ? {} : { export: exportColors as ThemeProfile["export"] }),
  };
}

/** Validate and clone a complete aggregate document; invalid documents return undefined. */
export function validateThemeLibrary(raw: unknown): ThemeLibrary | undefined {
  if (!isRecord(raw) || !hasOnlyKeys(raw, LIBRARY_KEYS) || raw.version !== THEME_LIBRARY_VERSION || !Array.isArray(raw.profiles)) {
    return undefined;
  }
  if (raw.profiles.length === 0) return undefined;
  const profiles: ThemeProfile[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const rawProfile of raw.profiles) {
    const profile = validateProfile(rawProfile);
    if (!profile || ids.has(profile.themeId) || names.has(profile.name)) return undefined;
    ids.add(profile.themeId);
    names.add(profile.name);
    profiles.push(profile);
  }
  return { version: THEME_LIBRARY_VERSION, profiles };
}

export function isValidThemeLibrary(raw: unknown): raw is ThemeLibrary {
  return validateThemeLibrary(raw) !== undefined;
}

/** Parse one persisted theme library or throw a descriptive validation error. */
export function parseThemeLibrary(raw: unknown, filePath = homeThemesFile()): ThemeLibrary {
  const parsed = validateThemeLibrary(raw);
  if (!parsed) throw new Error(`Invalid theme library: ${filePath}`);
  return parsed;
}

export function cloneThemeProfile(profile: ThemeProfile): ThemeProfile {
  return {
    themeId: profile.themeId,
    name: profile.name,
    colorMode: profile.colorMode,
    vars: { ...profile.vars },
    colors: { ...profile.colors },
    ...(profile.export === undefined ? {} : { export: { ...profile.export } }),
  };
}

export function cloneThemeLibrary(library: ThemeLibrary): ThemeLibrary {
  return { version: 1, profiles: library.profiles.map(cloneThemeProfile) };
}

function builtinLibrary(): ThemeLibrary {
  return {
    version: 1,
    profiles: BUILTIN_THEME_PROFILES.map(cloneThemeProfile),
  };
}

function fileFingerprint(filePath: string): string {
  try {
    const stats = statSync(filePath, { bigint: true });
    return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(":");
  } catch {
    return `missing:${filePath}`;
  }
}

function listBackups(filePath: string, persistence: ThemeLibraryPersistence): string[] {
  let entries: string[];
  try {
    entries = persistence.list(dirname(filePath));
  } catch {
    return [];
  }
  return entries.filter((entry) => BACKUP_PATTERN.test(entry)).sort().map((entry) => join(dirname(filePath), entry));
}

function nextBackupPath(filePath: string, persistence: ThemeLibraryPersistence): string | undefined {
  const existing = new Set(listBackups(filePath, persistence).map((path) => path.slice(dirname(filePath).length + 1)));
  for (let number = 1; number < 1_000; number += 1) {
    const name = `${THEMES_BACKUP_PREFIX}${String(number).padStart(3, "0")}${THEMES_BACKUP_SUFFIX}`;
    if (!existing.has(name)) return join(dirname(filePath), name);
  }
  return undefined;
}

function tryExists(filePath: string, persistence: ThemeLibraryPersistence): boolean {
  try {
    return persistence.exists(filePath);
  } catch {
    return false;
  }
}

function restoreOriginal(filePath: string, backupPath: string, persistence: ThemeLibraryPersistence): void {
  try {
    persistence.rename(backupPath, filePath);
  } catch {
    // The original remains recoverable at backupPath when restoration itself fails.
  }
}

function publishBuiltins(filePath: string, persistence: ThemeLibraryPersistence): void {
  persistence.writeJson(filePath, builtinLibrary());
}

/** Read and strictly validate one library file without repairing it. */
export function readThemeLibrary(filePath = homeThemesFile(), persistence: ThemeLibraryPersistence = defaultPersistence): ThemeLibrary {
  return parseThemeLibrary(persistence.readJson(filePath), filePath);
}

/** List numbered backup paths without modifying or validating them. */
export function listThemeLibraryBackups(filePath = homeThemesFile(), persistence: ThemeLibraryPersistence = defaultPersistence): string[] {
  return listBackups(filePath, persistence);
}

/** Read a numbered backup only when it is a complete valid theme library. */
export function readThemeLibraryBackup(filePath: string, persistence: ThemeLibraryPersistence = defaultPersistence): ThemeLibrary | undefined {
  try {
    return readThemeLibrary(filePath, persistence);
  } catch {
    return undefined;
  }
}

function finishLoad(library: ThemeLibrary, filePath: string, cacheable: boolean): ThemeLibrary {
  if (cacheable) cache = { filePath, fingerprint: fileFingerprint(filePath), library: cloneThemeLibrary(library) };
  return cloneThemeLibrary(library);
}

/**
 * Load the optional home library. Bad or unavailable storage never blocks the
 * caller: built-ins are returned in memory, while successful publication is
 * attempted atomically and corrupt primaries are preserved as numbered backups.
 */
export function loadThemeLibrary(persistence: ThemeLibraryPersistence = defaultPersistence): ThemeLibrary {
  const filePath = homeThemesFile();
  const cacheable = persistence === defaultPersistence;
  if (cacheable) {
    const fingerprint = fileFingerprint(filePath);
    if (cache?.filePath === filePath && cache.fingerprint === fingerprint) return cloneThemeLibrary(cache.library);
  }

  if (!tryExists(filePath, persistence)) {
    try {
      publishBuiltins(filePath, persistence);
    } catch {
      // Optional visual state may remain memory-only when home storage is unavailable.
    }
    return finishLoad(builtinLibrary(), filePath, cacheable);
  }

  try {
    const parsed = readThemeLibrary(filePath, persistence);
    try { persistence.chmod(filePath, 0o600); } catch { /* keep valid in-memory edits usable */ }
    return finishLoad(parsed, filePath, cacheable);
  } catch {
    // Continue to recovery below. The original primary has not been written.
  }

  const backupPath = nextBackupPath(filePath, persistence);
  if (!backupPath) return finishLoad(builtinLibrary(), filePath, cacheable);
  try {
    persistence.rename(filePath, backupPath);
  } catch {
    return finishLoad(builtinLibrary(), filePath, cacheable);
  }
  try {
    persistence.chmod(backupPath, 0o600);
  } catch {
    restoreOriginal(filePath, backupPath, persistence);
    return finishLoad(builtinLibrary(), filePath, cacheable);
  }
  try {
    publishBuiltins(filePath, persistence);
  } catch {
    restoreOriginal(filePath, backupPath, persistence);
    return finishLoad(builtinLibrary(), filePath, cacheable);
  }
  return finishLoad(builtinLibrary(), filePath, cacheable);
}

export function clearThemeLibraryCache(): void {
  cache = undefined;
}

export function getBuiltinThemeProfiles(): ThemeProfile[] {
  return BUILTIN_THEME_PROFILES.map(cloneThemeProfile);
}

export function getBuiltinThemeFallback(): ThemeProfile {
  return cloneThemeProfile(BUILTIN_THEME_PROFILES.find((profile) => profile.themeId === DEFAULT_THEME_ID) ?? BUILTIN_THEME_PROFILES[0]!);
}

export function getThemeProfile(themeId: string | undefined, library: ThemeLibrary = loadThemeLibrary()): ThemeProfile {
  const profile = typeof themeId === "string" ? library.profiles.find((candidate) => candidate.themeId === themeId) : undefined;
  return cloneThemeProfile(profile ?? getBuiltinThemeFallback());
}

export function resolveThemeProfile(themeId: string | undefined, library: ThemeLibrary = loadThemeLibrary()): {
  readonly profile: ThemeProfile;
  readonly usedFallback: boolean;
} {
  const profile = typeof themeId === "string" ? library.profiles.find((candidate) => candidate.themeId === themeId) : undefined;
  return { profile: cloneThemeProfile(profile ?? getBuiltinThemeFallback()), usedFallback: profile === undefined };
}

export const themeLibraryPath = homeThemesFile;
export const loadThemes = loadThemeLibrary;
export const getThemes = loadThemeLibrary;
