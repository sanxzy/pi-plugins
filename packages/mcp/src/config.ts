import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse, type ParseError } from "jsonc-parser";
import { printParseErrorCode } from "jsonc-parser";

const USER_CONFIG_NAME = "mcp.json";
const PROJECT_CONFIG_RELATIVE = join(".pi", "mcp.json");

export interface McpTimeoutConfig {
  startup?: number;
  request?: number;
}

export interface McpOAuthConfig {
  client_id?: string;
  client_secret?: string;
  scope?: string;
  callback_port?: number;
  redirect_uri?: string;
}

export interface McpLocalServerConfig {
  type: "local";
  command: string[];
  cwd?: string;
  environment?: Record<string, string>;
  disabled?: boolean;
  timeout?: McpTimeoutConfig;
}

export interface McpRemoteServerConfig {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig | false;
  disabled?: boolean;
  timeout?: McpTimeoutConfig;
}

export type McpServerConfig = McpLocalServerConfig | McpRemoteServerConfig;

export interface McpConfig {
  /** Global default timeouts when a server does not specify them. */
  timeout?: McpTimeoutConfig;
  servers: Record<string, McpServerConfig>;
}

export interface McpConfigLoadOptions {
  /**
   * Environment used to expand `${VAR}` references in configuration string
   * values and to seed the local process environment. Defaults to
   * `process.env` when omitted.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Working directory used to resolve relative local server `cwd` values and
   * as the base for the project configuration path. Defaults to
   * `process.cwd()` when omitted.
   */
  cwd?: string;
  /** Optional absolute agent directory override for tests. */
  agentDir?: string;
}

export type McpConfigResult =
  | { ok: true; value: McpConfig }
  | { ok: false; code: "missing" | "invalid" | "io"; message: string };

const TOKEN_PATTERN = /[A-Za-z0-9._~+/=-]{12,}/g;

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(TOKEN_PATTERN, "[Redacted]");
  return "Unknown configuration error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve the user agent directory, honoring an explicit override. */
export function userAgentDir(override?: string): string {
  if (override) return override;
  return getAgentDir();
}

/** Absolute path of the user-level MCP configuration file. */
export function userConfigPath(agentDir: string): string {
  return join(agentDir, USER_CONFIG_NAME);
}

/** Absolute path of the project-level MCP configuration file. */
export function projectConfigPath(projectRoot: string): string {
  return join(projectRoot, PROJECT_CONFIG_RELATIVE);
}

/**
 * Replace `${VAR}` references in a string using the supplied environment.
 * Unknown references expand to the empty string so missing values degrade
 * safely without throwing.
 */
export function expandEnv(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => env[name] ?? "");
}

/** Recursively expand environment references inside a parsed JSONC document. */
function expandNode(node: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof node === "string") return expandEnv(node, env);
  if (Array.isArray(node)) return node.map((item) => expandNode(item, env));
  if (isRecord(node)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) result[key] = expandNode(value, env);
    return result;
  }
  return node;
}

/** Parse JSONC with comments and trailing commas into a plain value. */
export function parseJsonc(content: string): { value: unknown } | { error: string } {
  const errors: ParseError[] = [];
  const value = parse(content, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0];
    return { error: `JSONC parse error at offset ${first.offset}: ${printParseErrorCode(first.error)}` };
  }
  return { value };
}

/** Read and parse a JSONC file, returning a structured result. */
export function readJsoncFile(
  filePath: string,
): { ok: false; code: "missing" | "invalid" | "io"; message: string } | { ok: true; value: unknown } {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, code: "missing", message: "MCP configuration does not exist" };
    return { ok: false, code: "io", message: `Unable to read MCP configuration: ${safeErrorMessage(error)}` };
  }
  const parsed = parseJsonc(content);
  if ("error" in parsed) return { ok: false, code: "invalid", message: parsed.error };
  return { ok: true, value: parsed.value };
}

function mergeTimeouts(left?: McpTimeoutConfig, right?: McpTimeoutConfig): McpTimeoutConfig | undefined {
  if (!left && !right) return undefined;
  return {
    ...(left?.startup !== undefined ? { startup: left.startup } : {}),
    ...(right?.startup !== undefined ? { startup: right.startup } : {}),
    ...(left?.request !== undefined ? { request: left.request } : {}),
    ...(right?.request !== undefined ? { request: right.request } : {}),
  };
}

/**
 * Deep-merge two server configurations, treating the right (`project`) entry
 * as authoritative for scalar fields while preserving disjoint fields and
 * nested timeout values from the left (`user`) entry.
 */
function mergeServer(left: McpServerConfig, right: McpServerConfig): McpServerConfig {
  if (left.type !== right.type) return right;
  if (left.type === "local" && right.type === "local") {
    return {
      type: "local",
      command: right.command,
      cwd: right.cwd ?? left.cwd,
      environment: right.environment ?? left.environment,
      disabled: right.disabled ?? left.disabled,
      timeout: mergeTimeouts(left.timeout, right.timeout),
    };
  }
  if (left.type === "remote" && right.type === "remote") {
    return {
      type: "remote",
      url: right.url,
      headers: right.headers ?? left.headers,
      oauth: right.oauth ?? left.oauth,
      disabled: right.disabled ?? left.disabled,
      timeout: mergeTimeouts(left.timeout, right.timeout),
    };
  }
  return right;
}

function parseServer(name: string, value: unknown): McpServerConfig | { error: string } {
  if (!isRecord(value)) return { error: `MCP server "${name}" must be an object` };
  if (value.type === "local") {
    if (!Array.isArray(value.command) || value.command.some((item) => typeof item !== "string")) {
      return { error: `MCP server "${name}" must define a string command array` };
    }
    const result: McpLocalServerConfig = { type: "local", command: [...(value.command as string[])] };
    if (typeof value.cwd === "string") result.cwd = value.cwd;
    if (isRecord(value.environment)) {
      result.environment = Object.fromEntries(
        Object.entries(value.environment).map(([key, item]) => [key, String(item)]),
      );
    }
    if (typeof value.disabled === "boolean") result.disabled = value.disabled;
    const timeout = parseTimeout(value.timeout);
    if ("error" in timeout) return { error: timeout.error };
    if (timeout.value) result.timeout = timeout.value;
    return result;
  }
  if (value.type === "remote") {
    if (typeof value.url !== "string" || value.url.length === 0) {
      return { error: `MCP server "${name}" must define a remote URL` };
    }
    const result: McpRemoteServerConfig = { type: "remote", url: value.url };
    if (isRecord(value.headers)) {
      result.headers = Object.fromEntries(Object.entries(value.headers).map(([key, item]) => [key, String(item)]));
    }
    if (value.oauth === false) {
      result.oauth = false;
    } else if (isRecord(value.oauth)) {
      const oauth: McpOAuthConfig = {};
      if (typeof value.oauth.client_id === "string") oauth.client_id = value.oauth.client_id;
      if (typeof value.oauth.client_secret === "string") oauth.client_secret = value.oauth.client_secret;
      if (typeof value.oauth.scope === "string") oauth.scope = value.oauth.scope;
      if (typeof value.oauth.callback_port === "number") oauth.callback_port = value.oauth.callback_port;
      if (typeof value.oauth.redirect_uri === "string") oauth.redirect_uri = value.oauth.redirect_uri;
      result.oauth = oauth;
    }
    if (typeof value.disabled === "boolean") result.disabled = value.disabled;
    const timeout = parseTimeout(value.timeout);
    if ("error" in timeout) return { error: timeout.error };
    if (timeout.value) result.timeout = timeout.value;
    return result;
  }
  return { error: `MCP server "${name}" has unsupported type` };
}

function parseTimeout(value: unknown): { value: McpTimeoutConfig | undefined } | { error: string } {
  if (value === undefined) return { value: undefined };
  if (!isRecord(value)) return { error: "MCP timeout must be an object with optional startup/request numbers" };
  const result: McpTimeoutConfig = {};
  if (value.startup !== undefined) {
    if (typeof value.startup !== "number" || !Number.isFinite(value.startup)) {
      return { error: "MCP timeout.startup must be a finite number" };
    }
    result.startup = value.startup;
  }
  if (value.request !== undefined) {
    if (typeof value.request !== "number" || !Number.isFinite(value.request)) {
      return { error: "MCP timeout.request must be a finite number" };
    }
    result.request = value.request;
  }
  return { value: result };
}

function parseConfigDocument(document: unknown): McpConfig | { error: string; server?: string } {
  if (!isRecord(document)) return { error: "MCP configuration must be an object" };
  const root = document as Record<string, unknown>;
  const config: McpConfig = { servers: {} };

  // Global timeout defaults may live at the top of the document.
  if (root.timeout !== undefined) {
    const timeout = parseTimeout(root.timeout);
    if ("error" in timeout) return { error: timeout.error };
    config.timeout = timeout.value;
  }

  if (root.mcp === undefined) return config;
  if (!isRecord(root.mcp)) return { error: "MCP configuration \"mcp\" must be an object" };
  const mcp = root.mcp as Record<string, unknown>;

  if (mcp.servers === undefined) return config;
  if (!isRecord(mcp.servers)) return { error: "MCP configuration \"mcp.servers\" must be an object of servers" };
  for (const [name, entry] of Object.entries(mcp.servers)) {
    const parsed = parseServer(name, entry);
    if ("error" in parsed) return { error: parsed.error, server: name };
    config.servers[name] = parsed;
  }
  return config;
}

/**
 * Load, parse, expand, validate, and deep-merge the user-level and project-level
 * MCP configuration sources. Missing sources are harmless. Invalid files or
 * individual invalid entries fail closed with a structured result that never
 * exposes resolved secret values.
 */
export function loadMcpConfig(
  agentDir: string,
  projectRoot: string,
  options: McpConfigLoadOptions = {},
): McpConfigResult {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const userPath = userConfigPath(agentDir);
  const projectPath = projectConfigPath(projectRoot);

  const userRead = readJsoncFile(userPath);
  let userConfig: McpConfig | undefined;
  if (userRead.ok === true) {
    const parsed = parseConfigDocument(userRead.value);
    if ("error" in parsed) {
      return { ok: false, code: "invalid", message: `Invalid user MCP configuration: ${parsed.error}` };
    }
    userConfig = parsed;
  } else if (userRead.code !== "missing") {
    return { ok: false, code: userRead.code, message: userRead.message };
  }

  const projectRead = readJsoncFile(projectPath);
  let projectConfig: McpConfig | undefined;
  if (projectRead.ok === true) {
    const parsed = parseConfigDocument(projectRead.value);
    if ("error" in parsed) {
      // A broken project file must not silently disable valid user servers.
      return { ok: false, code: "invalid", message: `Invalid project MCP configuration: ${parsed.error}` };
    }
    projectConfig = parsed;
  } else if (projectRead.code !== "missing") {
    return { ok: false, code: projectRead.code, message: projectRead.message };
  }

  // Merge remaining into single config.
  const merged: McpConfig = { servers: {} };
  if (userConfig?.timeout) merged.timeout = userConfig.timeout;
  if (projectConfig?.timeout) merged.timeout = mergeTimeouts(merged.timeout, projectConfig.timeout);

  const userServers = userConfig?.servers ?? {};
  const projectServers = projectConfig?.servers ?? {};
  for (const [name, entry] of Object.entries(userServers)) merged.servers[name] = entry;
  for (const [name, entry] of Object.entries(projectServers)) {
    merged.servers[name] = userServers[name] ? mergeServer(userServers[name], entry) : entry;
  }

  // Expand environment references in string fields (after validation to keep
  // errors stable), and make the environment available for callers.
  const expandedValue = expandNode(merged, env);

  void cwd;
  return { ok: true, value: expandedValue as McpConfig };
}
