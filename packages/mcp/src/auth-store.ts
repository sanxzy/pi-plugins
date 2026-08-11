import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Persistent, URL-scoped OAuth credential store for MCP servers.
 *
 * The store lives under the Pi agent directory (`<agentDir>/mcp-auth.json`).
 * Every entry is keyed by server URL so that credentials fetched for a changed
 * URL are never reused. Writes are atomic (temp file + rename) and the file is
 * created with owner-only permissions.
 */

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

export interface StoredClientInfo {
  clientId: string;
  clientSecret?: string;
  clientSecretExpiresAt?: number;
}

export interface StoredAuthEntry {
  serverUrl?: string;
  tokens?: StoredTokens;
  clientInfo?: StoredClientInfo;
  codeVerifier?: string;
  oauthState?: string;
}

export interface AuthStore {
  get(serverUrl: string): StoredAuthEntry | undefined;
  /** Return the entry only when its recorded serverUrl matches. */
  getForUrl(serverUrl: string): StoredAuthEntry | undefined;
  set(serverUrl: string, entry: StoredAuthEntry): void;
  update(serverUrl: string, update: (entry: StoredAuthEntry) => StoredAuthEntry): void;
  remove(serverUrl: string): void;
}

const AUTH_FILE_NAME = "mcp-auth.json";

/** Resolve the auth store path from a base agent directory. */
export function authStorePath(agentDir: string): string {
  return resolve(agentDir, AUTH_FILE_NAME);
}

function parseStored(serverUrl: string, data: unknown): StoredAuthEntry | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const serverUrlField = (data as Record<string, unknown>).serverUrl;
  if (typeof serverUrlField === "string" && serverUrlField !== serverUrl) return undefined;
  return data as StoredAuthEntry;
}

/** Create a file-backed auth store scoped to a single agent directory. */
export function createAuthStore(path: string): AuthStore {
  const load = (): Record<string, StoredAuthEntry> => {
    try {
      const content = readFileSync(path, "utf8");
      const parsed = JSON.parse(content) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      const out: Record<string, StoredAuthEntry> = {};
      for (const [url, value] of Object.entries(parsed as Record<string, unknown>)) {
        const entry = parseStored(url, value);
        if (entry) out[url] = entry;
      }
      return out;
    } catch {
      return {};
    }
  };

  const persist = (entries: Record<string, StoredAuthEntry>): void => {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(entries, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  };

  return {
    get(serverUrl) {
      return load()[serverUrl];
    },
    getForUrl(serverUrl) {
      const entry = load()[serverUrl];
      if (!entry) return undefined;
      return entry.serverUrl === serverUrl ? entry : undefined;
    },
    set(serverUrl, entry) {
      const entries = load();
      entries[serverUrl] = { ...entry, serverUrl };
      persist(entries);
    },
    update(serverUrl, update) {
      const entries = load();
      const prior = entries[serverUrl] ?? {};
      entries[serverUrl] = { ...update(prior), serverUrl };
      persist(entries);
    },
    remove(serverUrl) {
      const entries = load();
      delete entries[serverUrl];
      persist(entries);
    },
  };
}

/** Convenience: build an auth store under `<agentDir>/mcp-auth.json`. */
export function createDefaultAuthStore(agentDir: string): AuthStore {
  return createAuthStore(authStorePath(agentDir));
}

export { AUTH_FILE_NAME, join };
