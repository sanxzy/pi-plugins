import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse, type ParseError } from "jsonc-parser";
import { printParseErrorCode } from "jsonc-parser";

const USER_CONFIG_RELATIVE = join("pi-code", "mcp.json");
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

export interface McpConfigPermissions {
  /** Rule ordering matters; first match wins. */
  tools?: unknown[];
  prompts?: unknown[];
  resources?: unknown[];
}

export interface McpConfig {
  timeout?: McpTimeoutConfig;
  permissions?: McpConfigPermissions;
  servers: Record<string, McpServerConfig>;
}

export interface McpConfigLoadOptions {
  /** Environment used for `${VAR}` expansion. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Base directory for relative local-server cwd values. */
  cwd?: string;
}

export interface McpConfigIssue {
  source: "user" | "project";
  message: string;
  server?: string;
}

export type McpConfigResult =
  | { ok: true; value: McpConfig; issues: McpConfigIssue[] }
  | { ok: false; code: "missing" | "invalid" | "io"; message: string };

const TOKEN_PATTERN = /[A-Za-z0-9._~+/=-]{12,}/g;

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(TOKEN_PATTERN, "[Redacted]");
  return "Unknown configuration error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve the user-level MCP config through the pi-code namespace:
 * `<agentDir>/pi-code/mcp.json`.
 */
export function userAgentDir(override?: string): string {
  return override ?? getAgentDir();
}

export function userConfigPath(agentDir: string): string {
  return join(agentDir, USER_CONFIG_RELATIVE);
}

export function projectConfigPath(projectRoot: string): string {
  return join(projectRoot, PROJECT_CONFIG_RELATIVE);
}

/** Expand `${VAR}` references; unknown variables become empty strings. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => env[name] ?? "");
}

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

export function parseJsonc(content: string): { value: unknown } | { error: string } {
  const errors: ParseError[] = [];
  const value = parse(content, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0];
    return { error: `JSONC parse error at offset ${first.offset}: ${printParseErrorCode(first.error)}` };
  }
  return { value };
}

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

function mergeRecordMap(
  left?: Record<string, string>,
  right?: Record<string, string>,
): Record<string, string> | undefined {
  if (!left && !right) return undefined;
  return { ...(left ?? {}), ...(right ?? {}) };
}

function mergeServer(left: McpServerConfig, right: McpServerConfig): McpServerConfig {
  if (left.type !== right.type) return right;
  if (left.type === "local" && right.type === "local") {
    return {
      type: "local",
      command: right.command,
      cwd: right.cwd ?? left.cwd,
      environment: mergeRecordMap(left.environment, right.environment),
      disabled: right.disabled ?? left.disabled,
      timeout: mergeTimeouts(left.timeout, right.timeout),
    };
  }
  if (left.type === "remote" && right.type === "remote") {
    return {
      type: "remote",
      url: right.url,
      headers: mergeRecordMap(left.headers, right.headers),
      oauth: right.oauth ?? left.oauth,
      disabled: right.disabled ?? left.disabled,
      timeout: mergeTimeouts(left.timeout, right.timeout),
    };
  }
  return right;
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
    if (value.oauth === false) result.oauth = false;
    else if (isRecord(value.oauth)) {
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

interface ParsedDocument {
  config: McpConfig;
  issues: Array<{ message: string; server?: string }>;
}

function parseConfigDocument(document: unknown): ParsedDocument | { error: string } {
  if (!isRecord(document)) return { error: "MCP configuration must be an object" };
  const root = document as Record<string, unknown>;
  const config: McpConfig = { servers: {} };
  const issues: Array<{ message: string; server?: string }> = [];
  const mcp = root.mcp;

  if (mcp === undefined) return { config, issues };
  if (!isRecord(mcp)) return { error: "MCP configuration \"mcp\" must be an object" };

  const timeout = parseTimeout(mcp.timeout);
  if ("error" in timeout) return { error: timeout.error };
  if (timeout.value) config.timeout = timeout.value;

  if (isRecord(mcp.permissions)) {
    config.permissions = {};
    if (Array.isArray(mcp.permissions.tools)) config.permissions.tools = mcp.permissions.tools;
    if (Array.isArray(mcp.permissions.prompts)) config.permissions.prompts = mcp.permissions.prompts;
    if (Array.isArray(mcp.permissions.resources)) config.permissions.resources = mcp.permissions.resources;
  }

  if (mcp.servers === undefined) return { config, issues };
  if (!isRecord(mcp.servers)) return { error: "MCP configuration \"mcp.servers\" must be an object of servers" };
  for (const [name, entry] of Object.entries(mcp.servers)) {
    const parsed = parseServer(name, entry);
    if ("error" in parsed) issues.push({ server: name, message: parsed.error });
    else config.servers[name] = parsed;
  }
  return { config, issues };
}

/** Resolve local-process environment and configured overrides for a server. */
export function resolveLocalEnvironment(
  server: McpLocalServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  return { ...inherited, ...(server.environment ?? {}) };
}

/** Resolve a local server cwd relative to the current session cwd. */
export function resolveLocalCwd(server: McpLocalServerConfig, cwd: string): string {
  return resolve(cwd, server.cwd ?? ".");
}

/** Load both config sources, retaining valid entries and structured diagnostics. */
export function loadMcpConfig(
  agentDir: string,
  projectRoot: string,
  options: McpConfigLoadOptions = {},
): McpConfigResult {
  const env = options.env ?? process.env;
  const issues: McpConfigIssue[] = [];
  const readSource = (source: "user" | "project", filePath: string): McpConfig | undefined => {
    const read = readJsoncFile(filePath);
    if (read.ok === false) {
      if (read.code !== "missing") issues.push({ source, message: read.message });
      return undefined;
    }
    const parsed = parseConfigDocument(read.value);
    if ("error" in parsed) {
      issues.push({ source, message: parsed.error });
      return undefined;
    }
    issues.push(...parsed.issues.map((issue) => ({ source, ...issue })));
    return parsed.config;
  };

  const userConfig = readSource("user", userConfigPath(agentDir));
  const projectConfig = readSource("project", projectConfigPath(projectRoot));
  const merged: McpConfig = {
    timeout: mergeTimeouts(userConfig?.timeout, projectConfig?.timeout),
    servers: {},
  };
  if (!merged.timeout) delete merged.timeout;
  if (userConfig?.permissions || projectConfig?.permissions) {
    merged.permissions = {
      // Project rules precede user rules because policy evaluation is
      // first-match-wins and project configuration has precedence.
      tools: [...(projectConfig?.permissions?.tools ?? []), ...(userConfig?.permissions?.tools ?? [])],
      prompts: [...(projectConfig?.permissions?.prompts ?? []), ...(userConfig?.permissions?.prompts ?? [])],
      resources: [...(projectConfig?.permissions?.resources ?? []), ...(userConfig?.permissions?.resources ?? [])],
    };
  }

  const userServers = userConfig?.servers ?? {};
  const projectServers = projectConfig?.servers ?? {};
  for (const [name, entry] of Object.entries(userServers)) merged.servers[name] = entry;
  for (const [name, entry] of Object.entries(projectServers)) {
    merged.servers[name] = userServers[name] ? mergeServer(userServers[name], entry) : entry;
  }

  return { ok: true, value: expandNode(merged, env) as McpConfig, issues };
}
