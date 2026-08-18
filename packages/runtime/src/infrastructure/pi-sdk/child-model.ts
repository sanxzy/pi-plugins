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
