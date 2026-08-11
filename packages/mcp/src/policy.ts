import type { McpConfig } from "./config.ts";

/**
 * Ordered MCP permission policy.
 *
 * Rules are ordered; the first rule whose `server`/`name` patterns match the
 * requested MCP item decides. Project rules are resolved after user rules
 * (project precedence). A rule's effect is one of `allow`, `ask`, or `deny`,
 * and the default is `allow`.
 */

export type PolicyEffect = "allow" | "deny" | "ask";
export type PolicyTarget = "tool" | "prompt" | "resource";

export interface PolicyRule {
  effect: PolicyEffect;
  /** Glob over server name; `*` matches all. */
  server?: string;
  /** Glob over tool/prompt/resource name; `*` matches all. */
  name?: string;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  /** Index of the matching rule, or -1 when the default applies. */
  matchedRule?: number;
}

export interface McpPolicy {
  tool: PolicyRule[];
  prompt: PolicyRule[];
  resource: PolicyRule[];
}

/** Convert a glob pattern (with `*`) into a RegExp. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`);
}

function globMatches(pattern: string, value: string): boolean {
  return globToRegExp(pattern).test(value);
}

function ruleMatches(rule: PolicyRule, server: string, name: string): boolean {
  if (rule.server && !globMatches(rule.server, server)) return false;
  if (rule.name && !globMatches(rule.name, name)) return false;
  return true;
}

function decide(rules: PolicyRule[], server: string, name: string): PolicyDecision {
  for (let index = 0; index < rules.length; index += 1) {
    if (ruleMatches(rules[index]!, server, name)) {
      return { effect: rules[index]!.effect, matchedRule: index };
    }
  }
  return { effect: "allow", matchedRule: -1 };
}

/**
 * Evaluate policy for a target kind. `ask` is resolved by the caller (the
 * interactive confirmation path); the decision here reports the effect.
 */
export function evaluatePolicy(policy: McpPolicy, kind: PolicyTarget, server: string, name: string): PolicyDecision {
  return decide(policy[kind] ?? [], server, name);
}

const VALID_EFFECTS = new Set<PolicyEffect>(["allow", "ask", "deny"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRule(value: unknown): PolicyRule | undefined {
  if (!isRecord(value)) return undefined;
  const effect = value.effect as PolicyEffect;
  if (!VALID_EFFECTS.has(effect)) return undefined;
  const rule: PolicyRule = { effect };
  if (typeof value.server === "string") rule.server = value.server;
  if (typeof value.name === "string") rule.name = value.name;
  return rule;
}

function parseRules(value: unknown): PolicyRule[] {
  if (!Array.isArray(value)) return [];
  return value.map(parseRule).filter((rule): rule is PolicyRule => rule !== undefined);
}

/** Build a policy from the merged `mcp.permissions` mapping. */
export function policyFromConfig(permissions: unknown): McpPolicy {
  if (!isRecord(permissions)) {
    return { tool: [], prompt: [], resource: [] };
  }
  return {
    tool: parseRules(permissions.tools),
    prompt: parseRules(permissions.prompts),
    resource: parseRules(permissions.resources),
  };
}

/**
 * Merge user and project policies into project-precedence order (first match
 * wins, and project rules are evaluated before user rules).
 */
export function mergeMcpPolicies(user: McpPolicy, project: McpPolicy): McpPolicy {
  return {
    tool: [...(project.tool ?? []), ...(user.tool ?? [])],
    prompt: [...(project.prompt ?? []), ...(user.prompt ?? [])],
    resource: [...(project.resource ?? []), ...(user.resource ?? [])],
  };
}