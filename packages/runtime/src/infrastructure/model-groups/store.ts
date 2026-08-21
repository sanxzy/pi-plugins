import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { homeModelGroupsFile as sharedHomeModelGroupsFile } from "../../shared/paths.ts";
import { isQuarantined } from "./quarantine.ts";

export const homeModelGroupsFile = sharedHomeModelGroupsFile;
export function homeModelGroupsFilePath(): string { return homeModelGroupsFile(); }
export const homeModelGroupsFileAlias = homeModelGroupsFile;

export type ModelGroupMode = "fallback" | "round-robin";
export interface ModelGroupEntry {
  ref: string;
  thinking?: string;
  reasoning?: boolean;
}
export interface ModelGroup {
  id: string;
  name: string;
  mode: ModelGroupMode;
  quarantineMinutes: number;
  /** Optional user-selected cap for every model in the group. */
  contextWindow?: number;
  models: ModelGroupEntry[];
}
export interface ModelGroupsFile {
  groups: ModelGroup[];
  activeGroupId?: string;
}

const DEFAULT_QUARANTINE = 5;
const MODEL_GROUP_HOST_API_KEY = "pi-c2.model-groups";
let cachedFingerprint = "";
let cached: ModelGroupsFile | undefined;
let roundRobinPointers = new Map<string, number>();

function fingerprint(file: string): string {
  try {
    const st = statSync(file);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch { return `missing:${file}`; }
}
function cloneFile(value: ModelGroupsFile): ModelGroupsFile {
  return { groups: value.groups.map((g) => ({ ...g, models: g.models.map((m) => ({ ...m })) })), activeGroupId: value.activeGroupId };
}
function isValidRef(ref: unknown): boolean {
  if (typeof ref !== "string") return false;
  const trimmed = ref.trim();
  if (trimmed.length === 0) return false;
  // Provider-scoped references may carry slashes inside the model id
  // (for example openrouter/stealth/ox-alpha): only the first "/" separates
  // provider from id, so extra segments are allowed but must be non-empty.
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(trimmed);
}
function normalizeEntry(raw: unknown): ModelGroupEntry | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  if (!isValidRef(obj.ref)) return undefined;
  const entry: ModelGroupEntry = { ref: String(obj.ref).trim() };
  if (typeof obj.thinking === "string" && obj.thinking.trim().length > 0) entry.thinking = obj.thinking.trim();
  if (typeof obj.reasoning === "boolean") entry.reasoning = obj.reasoning;
  return entry;
}
function validateGroup(raw: unknown): ModelGroup | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  const mode = obj.mode as ModelGroupMode;
  if (id.length === 0) return undefined;
  if (name.length === 0) return undefined;
  if (mode !== "fallback" && mode !== "round-robin") return undefined;
  let q = DEFAULT_QUARANTINE;
  if (obj.quarantineMinutes !== undefined) {
    if (typeof obj.quarantineMinutes !== "number" || !Number.isInteger(obj.quarantineMinutes) || obj.quarantineMinutes < 1 || obj.quarantineMinutes > 60) return undefined;
    q = obj.quarantineMinutes;
  }
  let contextWindow: number | undefined;
  if (obj.contextWindow !== undefined) {
    if (typeof obj.contextWindow !== "number" || !Number.isInteger(obj.contextWindow) || obj.contextWindow < 1) return undefined;
    contextWindow = obj.contextWindow;
  }
  const rawModels = Array.isArray(obj.models) ? obj.models : [];
  const models: ModelGroupEntry[] = [];
  for (const m of rawModels) {
    const e = normalizeEntry(m);
    if (!e) return undefined;
    models.push(e);
  }
  if (models.length === 0) return undefined;
  return { id, name, mode, quarantineMinutes: q, ...(contextWindow === undefined ? {} : { contextWindow }), models };
}
function parseFile(raw: unknown): ModelGroupsFile {
  if (!raw || typeof raw !== "object") return { groups: [], activeGroupId: undefined };
  const obj = raw as Record<string, unknown>;
  const rawGroups = Array.isArray(obj.groups) ? obj.groups : [];
  const groups: ModelGroup[] = [];
  for (const g of rawGroups) {
    const validated = validateGroup(g);
    if (validated) groups.push(validated);
  }
  let activeGroupId: string | undefined;
  if (typeof obj.activeGroupId === "string" && obj.activeGroupId.trim().length > 0) {
    const exists = groups.some((g) => g.id === obj.activeGroupId);
    if (exists) activeGroupId = obj.activeGroupId;
  }
  return { groups, activeGroupId };
}

export function getModelGroups(): ModelGroupsFile {
  const file = homeModelGroupsFile();
  const fp = fingerprint(file);
  if (cached && cachedFingerprint === fp) return cloneFile(cached);
  let parsed: ModelGroupsFile = { groups: [], activeGroupId: undefined };
  try {
    if (existsSync(file)) {
      const text = readFileSync(file, "utf8");
      const json = JSON.parse(text);
      parsed = parseFile(json);
    }
  } catch {
    parsed = { groups: [], activeGroupId: undefined };
  }
  cached = cloneFile(parsed);
  cachedFingerprint = fp;
  return cloneFile(parsed);
}

export function saveModelGroups(next: ModelGroupsFile): { ok: true } | { ok: false; error: string } {
  for (const g of next.groups) {
    const validated = validateGroup(g);
    if (!validated) return { ok: false, error: `Invalid group ${g.id}` };
    for (const m of g.models) if (!isValidRef(m.ref)) return { ok: false, error: `Invalid model ref ${m.ref}` };
  }
  if (next.activeGroupId !== undefined) {
    if (!next.groups.some((g) => g.id === next.activeGroupId)) {
      next = { ...next, activeGroupId: undefined };
    }
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const g of next.groups) {
    if (ids.has(g.id)) return { ok: false, error: `Duplicate group id ${g.id}` };
    if (names.has(g.name)) return { ok: false, error: `Duplicate group name ${g.name}` };
    ids.add(g.id); names.add(g.name);
  }
  const file = homeModelGroupsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
  chmodSync(file, 0o600);
  cached = cloneFile(next.activeGroupId ? next : { ...next, activeGroupId: next.activeGroupId && ids.has(next.activeGroupId) ? next.activeGroupId : undefined });
  cachedFingerprint = fingerprint(file);
  return { ok: true };
}

export function clearModelGroupsCache(): void { cached = undefined; cachedFingerprint = ""; }

export function resolveActiveModel(options?: { readonly advance?: boolean }): ModelGroupEntry | undefined {
  const advance = options?.advance ?? true;
  const { groups, activeGroupId } = getModelGroups();
  if (!activeGroupId) return undefined;
  const group = groups.find((g) => g.id === activeGroupId);
  if (!group) return undefined;
  const available = group.models.filter((m) => !isQuarantined(m.ref));
  if (available.length === 0) return undefined;
  if (group.mode === "fallback") return available[0];
  let idx = roundRobinPointers.get(group.id) ?? 0;
  for (let i = 0; i < group.models.length; i++) {
    const candidate = group.models[(idx + i) % group.models.length]!;
    if (!isQuarantined(candidate.ref)) {
      // Activation peeks at the current member; per-request resolution advances.
      if (advance) roundRobinPointers.set(group.id, (idx + i + 1) % group.models.length);
      return candidate;
    }
  }
  return available[0];
}

export function getActiveGroup(): ModelGroup | undefined {
  const { groups, activeGroupId } = getModelGroups();
  if (!activeGroupId) return undefined;
  return groups.find((g) => g.id === activeGroupId);
}

export function clearRoundRobinPointers(): void { roundRobinPointers.clear(); }

export function deriveGroupContextWindow(group: ModelGroup, catalog: Array<{ id: string; provider: string; contextWindow?: number }>): number | undefined {
  let min: number | undefined;
  for (const m of group.models) {
    // Model ids may contain slashes (openrouter/stealth/ox-alpha): only the
    // first "/" separates provider from id.
    const separator = m.ref.indexOf("/");
    const provider = separator === -1 ? m.ref : m.ref.slice(0, separator);
    const id = separator === -1 ? undefined : m.ref.slice(separator + 1);
    const found = catalog.find((c) => c.provider === provider && c.id === id);
    const cw = found?.contextWindow;
    if (typeof cw !== "number" || cw <= 0) continue;
    if (min === undefined || cw < min) min = cw;
  }
  if (group.contextWindow === undefined) return min;
  return min === undefined ? group.contextWindow : Math.min(group.contextWindow, min);
}

export function clearActiveGroup(): void {
  const current = getModelGroups();
  if (current.activeGroupId === undefined) return;
  saveModelGroups({ ...current, activeGroupId: undefined });
}

export interface ModelGroupHostItem {
  readonly id: string;
  readonly name: string;
  readonly mode: ModelGroupMode;
  readonly modelRefs: readonly string[];
  readonly contextWindow?: number;
  readonly active: boolean;
}

export type ModelGroupHostActivation =
  | { readonly ok: true; readonly groupId: string; readonly groupName: string; readonly modelRef: string; readonly thinking?: string; readonly contextWindow?: number }
  | { readonly ok: false; readonly error: string };

export interface ModelGroupHostApi {
  readonly list: () => readonly ModelGroupHostItem[];
  readonly activate: (id: string) => ModelGroupHostActivation;
  /** Resolve and advance the active group's current member (per request). */
  readonly resolveActive: () => { ref: string; thinking?: string; contextWindow?: number } | undefined;
  readonly clearActiveGroup: () => void;
}

export function installModelGroupHostApi(): void {
  const api: ModelGroupHostApi = {
    list: () => {
      const file = getModelGroups();
      return file.groups.map((group) => ({
        id: group.id,
        name: group.name,
        mode: group.mode,
        modelRefs: group.models.map((model) => model.ref),
        ...(group.contextWindow === undefined ? {} : { contextWindow: group.contextWindow }),
        active: group.id === file.activeGroupId,
      }));
    },
    activate: (id) => {
      const file = getModelGroups();
      const group = file.groups.find((item) => item.id === id);
      if (!group) return { ok: false, error: `Unknown model group: ${id}` };
      const saved = saveModelGroups({ groups: file.groups, activeGroupId: id });
      if (!saved.ok) return { ok: false, error: saved.error };
      const model = resolveActiveModel({ advance: false });
      if (!model) return { ok: false, error: `All models in group '${group.name}' are quarantined.` };
      return {
        ok: true,
        groupId: group.id,
        groupName: group.name,
        modelRef: model.ref,
        ...(model.thinking === undefined ? {} : { thinking: model.thinking }),
        ...(group.contextWindow === undefined ? {} : { contextWindow: group.contextWindow }),
      };
    },
    /**
     * Resolve (and advance) the active group's current member. Called once per
     * user request by the host patch so round-robin groups rotate per turn.
     */
    resolveActive: () => {
      const file = getModelGroups();
      const group = file.groups.find((item) => item.id === file.activeGroupId);
      if (!group) return undefined;
      const model = resolveActiveModel();
      if (!model) return undefined;
      return {
        ref: model.ref,
        ...(model.thinking === undefined ? {} : { thinking: model.thinking }),
        ...(group.contextWindow === undefined ? {} : { contextWindow: group.contextWindow }),
      };
    },
    clearActiveGroup: () => clearActiveGroup(),
  };
  (globalThis as typeof globalThis & { [key: symbol]: unknown })[Symbol.for(MODEL_GROUP_HOST_API_KEY)] = api;
}

export const _test = { validateGroup, parseFile, isValidRef, MODEL_GROUP_HOST_API_KEY };
