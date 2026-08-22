/**
 * Exact-only child model resolution.
 *
 * An agent frontmatter `model` value is an exact contract: it must resolve to
 * a model in the child's catalog by exact reference (canonical
 * `provider/modelId` or bare model id). There is deliberately no fuzzy
 * matching, no alias preference, no case normalization, and no fallback to
 * the parent model when the declared value is present but does not resolve.
 * The caller fails the child with a clear message so the user can correct the
 * frontmatter manually.
 */

import { THINKING_LEVELS } from "@xzy-ai/core";

export interface ExactModelLike {
  id: string;
  provider: string;
}

export interface ExactModelCatalog {
  getModels(): readonly ExactModelLike[];
}

/**
 * Apply the child model resolution priority for one child agent:
 *
 *   frontmatter model > global config `agents.model` > parent model
 *
 * A configured value (frontmatter or global) is an exact contract: it must
 * resolve against the child catalog by exact reference. An unresolvable value
 * produces a clear `error` (never a silent fallback to the parent model) so
 * the user can correct the configuration manually. Only when no value is
 * configured at either level does the caller keep the parent model.
 */
export function resolveChildModelMapping(options: {
  frontmatterModel?: string;
  globalModel?: string;
  agentName: string;
  modelRuntime: ExactModelCatalog | undefined;
  globalConfigPath: string;
}): { model: ExactModelLike | undefined; error?: string } {
  if (options.frontmatterModel) {
    const declared = resolveExactChildModel(options.frontmatterModel, options.modelRuntime);
    if (!declared) {
      return {
        model: undefined,
        error: `Agent "${options.agentName}" declares model "${options.frontmatterModel}", which does not match any available model exactly. Fix the frontmatter model value or remove the key to inherit the parent model.`,
      };
    }
    return { model: declared };
  }
  if (options.globalModel) {
    const declared = resolveExactChildModel(options.globalModel, options.modelRuntime);
    if (!declared) {
      return {
        model: undefined,
        error: `Global agent model "${options.globalModel}" (from ${options.globalConfigPath} agents.model) does not match any available model exactly. Fix the value in the config file or remove the agents.model key to inherit the parent model.`,
      };
    }
    return { model: declared };
  }
  return { model: undefined };
}

/**
 * Apply the child thinking resolution priority for one child agent:
 *
 *   frontmatter thinking > global config `agents.thinking` > SDK default
 *
 * A configured value (frontmatter or global) is applied exactly as-is. An
 * invalid global level produces a clear `error` (frontmatter levels are
 * already normalized by discovery). Only when no value is configured at
 * either level does the caller keep the SDK default.
 */
export function resolveChildThinkingMapping(options: {
  frontmatterThinking?: string;
  globalThinking?: string;
  globalConfigPath: string;
}): { thinking?: string; error?: string } {
  if (options.frontmatterThinking) {
    return { thinking: options.frontmatterThinking };
  }
  if (options.globalThinking) {
    const level = options.globalThinking.trim();
    if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
      return {
        error: `Global agent thinking "${options.globalThinking}" (from ${options.globalConfigPath} agents.thinking) is not a valid thinking level. Fix the value in the config file or remove the agents.thinking key to inherit the SDK default.`,
      };
    }
    return { thinking: level };
  }
  return {};
}

/**
 * Resolve a frontmatter model reference by exact match only.
 *
 * A `provider/modelId` reference matches the single model with that provider
 * and id. A bare id matches only when exactly one model in the catalog has
 * that id (an ambiguous bare id is rejected rather than guessed). Everything
 * else — partial ids, case variants, thinking-level suffixes, unknown
 * references — returns `undefined`.
 */
export function resolveExactChildModel(
  modelReference: string,
  modelRuntime: ExactModelCatalog | undefined,
): ExactModelLike | undefined {
  const reference = modelReference.trim();
  if (!reference || !modelRuntime) return undefined;

  const available = [...modelRuntime.getModels()];
  const slashIndex = reference.indexOf("/");
  if (slashIndex !== -1) {
    const provider = reference.slice(0, slashIndex).trim();
    const modelId = reference.slice(slashIndex + 1).trim();
    if (!provider || !modelId) return undefined;
    const providerMatches = available.filter(
      (entry) => entry.provider === provider && entry.id === modelId,
    );
    if (providerMatches.length === 1) return providerMatches[0];
    return undefined;
  }

  const idMatches = available.filter((entry) => entry.id === reference);
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

/** A resolved child model binding: the outcome of applying the resolution
 * priority to one child agent.
 *
 *   - `model` — pinned to one exact catalog model (frontmatter or config).
 *   - `group` — explicitly bound to a model group via the `group:<id>` prefix;
 *     the child then behaves like a parent using that group (rotation,
 *     quarantine, fail-over among members).
 *   - `inherit` — nothing configured at either level; keep the parent's
 *     current model. A group-using parent reaches such children only through
 *     this inheritance, never as an override of explicit configuration.
 */
export type ChildModelBinding =
  | { readonly kind: "model"; readonly model: ExactModelLike }
  | { readonly kind: "group"; readonly groupId: string }
  | { readonly kind: "inherit" };

export interface GroupCatalog {
  findGroup(groupId: string): { id: string } | undefined;
}

/**
 * Parse a configured model value into its binding shape.
 *
 * A `group:<id>` value is an explicit model-group binding; every other
 * non-empty value is a plain exact model reference. Blank values mean no
 * binding at this level. A blank group id is preserved so the resolver can
 * reject it with a clear error instead of silently treating it as absent.
 */
export function parseModelBinding(value: string | undefined): ChildModelBindingInput | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("group:")) {
    return { kind: "group", groupId: trimmed.slice("group:".length).trim() };
  }
  return { kind: "model", reference: trimmed };
}

export type ChildModelBindingInput =
  | { readonly kind: "model"; readonly reference: string }
  | { readonly kind: "group"; readonly groupId: string };
/**
 * Apply the child model resolution priority for one child agent:
 *
 *   frontmatter `model` > global config `agents.model` > inherit parent
 *
 * Both levels accept plain model references and explicit `group:<id>`
 * bindings. A configured value is an exact contract: a model reference must
 * resolve against the child catalog, a group id must exist in the group
 * catalog; anything unresolvable produces a clear `error` (never a silent
 * fallback). Only when no value is configured at either level does the child
 * inherit the parent's current model.
 */
export function resolveChildModelBinding(options: {
  frontmatterModel?: string;
  globalModel?: string;
  agentName: string;
  modelRuntime: ExactModelCatalog | undefined;
  globalConfigPath: string;
  findGroup?: (groupId: string) => { id: string } | undefined;
}): { ok: true; binding: ChildModelBinding } | { ok: false; error: string } {
  const frontmatter = parseModelBinding(options.frontmatterModel);
  const global = frontmatter === undefined ? parseModelBinding(options.globalModel) : undefined;
  const selected = frontmatter ?? global;
  if (!selected) return { ok: true, binding: { kind: "inherit" } };
  const source = frontmatter ? `Agent "${options.agentName}" declares model` : "Global agent model";
  const location = frontmatter ? "" : ` (from ${options.globalConfigPath} agents.model)`;
  if (selected.kind === "group") {
    const known = options.findGroup?.(selected.groupId);
    if (!selected.groupId || !known) {
      return {
        ok: false,
        error: `${source} "group:${selected.groupId}"${location} names an unknown model group. Fix the value or remove it to inherit the parent model.`,
      };
    }
    return { ok: true, binding: { kind: "group", groupId: selected.groupId } };
  }
  const declared = resolveExactChildModel(selected.reference, options.modelRuntime);
  if (!declared) {
    return {
      ok: false,
      error: `${source} "${selected.reference}"${location} does not match any available model exactly. Fix the value or remove it to inherit the parent model.`,
    };
  }
  return { ok: true, binding: { kind: "model", model: declared } };
}

