/**
 * Home `models.json` model-override merge for extension-registered providers.
 *
 * The host composes provider catalogs as extension models first, then applies
 * the home config's `modelOverrides` on top — so a parent session sees e.g.
 * openai-codex/gpt-5.6-luna with its 260k contextWindow override. Isolated
 * child runtimes, however, receive only the raw `registerProvider(name,
 * config)` flush from the extension loader and would silently miss every
 * override. This module re-applies that topmost user-config layer to the
 * pending provider configs before they are registered into a child runtime,
 * keeping child identity data (context window, reasoning) identical to what
 * the host composed for the same provider.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Resolve `<agentDir>/models.json` for an isolated child runtime. */
export function homeModelsFileForAgentDir(agentDir: string): string {
  return join(agentDir, "models.json");
}

interface HomeModelsFile {
  providers?: Record<string, { modelOverrides?: Record<string, Record<string, unknown>> }>;
}

function readHomeModels(file: string): HomeModelsFile | undefined {
  try {
    if (!existsSync(file)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as HomeModelsFile) : undefined;
  } catch {
    // A malformed home file must never block child spawn; the host tolerates
    // it too (degrading to unoverridden catalogs).
    return undefined;
  }
}

interface ProviderModelConfig {
  id?: unknown;
  [key: string]: unknown;
}

/**
 * Return a shallow-copied provider config whose `models` entries carry the
 * home overrides for that provider. Models without matching overrides pass
 * through untouched; providers without overrides are returned unchanged.
 */
export function applyHomeModelOverrides(
  providerName: string,
  config: { models?: ProviderModelConfig[] },
  homeModels: HomeModelsFile | undefined,
): { models?: ProviderModelConfig[] } {
  const overrides = homeModels?.providers?.[providerName]?.modelOverrides;
  if (!overrides || typeof overrides !== "object") return config;
  if (!Array.isArray(config.models)) return config;
  return {
    ...config,
    models: config.models.map((model) => {
      if (!model || typeof model !== "object") return model;
      const id = typeof model.id === "string" ? model.id : undefined;
      const override = id ? overrides[id] : undefined;
      if (!override || typeof override !== "object") return model;
      return { ...model, ...override };
    }),
  };
}

/** Load the home overrides file from an agent dir (tolerating absence). */
export function loadHomeModelsForAgentDir(agentDir: string): HomeModelsFile | undefined {
  return readHomeModels(homeModelsFileForAgentDir(agentDir));
}
