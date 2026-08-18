import { readFileSync, writeFileSync } from "node:fs";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  removeFrontmatterKey,
  setFrontmatterKey,
  supportedThinkingLevels,
  type DiscoveredAgent,
  type FrontmatterKeyEdit,
  type ThinkingCapableModel,
} from "@xzy-ai/core";
import type {
  ManageAgentModelAgentItem,
  ManageAgentModelApplyResult,
  ManageAgentModelController,
  ManageAgentModelModelItem,
  ManageAgentModelThinkingItem,
} from "@xzy-ai/tui";
import {
  clearAgentDiscoveryCache,
  clearSettingsCache,
  createCachedAgentDiscovery,
  resolveSettingsForProject,
  settingsConfigPath,
} from "@xzy-ai/runtime";

/**
 * UI-agnostic boundary implemented by the commands package and driven by the
 * TUI wizard. Reads agent definitions from the shared cached discovery and
 * model references from the session's model registry.
 */
export interface ManageAgentModelControllerOptions {
  cwd: string;
  modelRegistry: Pick<ModelRegistry, "getAvailable">;
}

/** A model as exposed by the session registry (provider + id + thinking caps). */
interface RegistryModel extends ThinkingCapableModel {
  readonly provider: string;
  readonly id: string;
}

/** Format a model as the canonical `/model` reference string. */
export function formatModelReference(model: RegistryModel): string {
  return `${model.provider}/${model.id}`;
}

/** Read the current settings config as a plain object; malformed or missing input degrades to `{}`. */
function readSettingsConfig(filePath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Write the settings config with the same formatting the bootstrap uses. */
function writeSettingsConfig(filePath: string, value: Record<string, unknown>): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Create the controller for `/manage-agent-model`.
 *
 * The agent list comes from the shared cached discovery (same seam as the
 * `agent` tool); the model list comes from the session model registry. Writes
 * rewrite only the `model` key of the target agent file's frontmatter (or the
 * `agents.model` key of the home-root `pi-c2/config.json`) and clear the
 * discovery/settings caches so subsequent `agent` calls resolve the new model.
 */
export function createManageAgentModelController(options: ManageAgentModelControllerOptions): ManageAgentModelController {
  const { cwd, modelRegistry } = options;

  function agents(): readonly ManageAgentModelAgentItem[] {
    return createCachedAgentDiscovery(cwd)
      .all()
      .map((agent: DiscoveredAgent) => ({
        name: agent.name,
        description: agent.description,
        model: agent.model,
        thinking: agent.thinking,
        filePath: agent.filePath,
      }));
  }

  function models(): readonly ManageAgentModelModelItem[] {
    const available = modelRegistry.getAvailable();
    return available
      .map((model) => ({ model, reference: formatModelReference(model) }))
      .sort((a, b) => a.reference.localeCompare(b.reference))
      .map(({ model, reference }) => ({ provider: model.provider, id: model.id, reference }));
  }

  function findModel(reference: string): RegistryModel | undefined {
    const available = modelRegistry.getAvailable() as readonly RegistryModel[];
    return available.find((model) => formatModelReference(model) === reference);
  }

  function findAgent(name: string): ManageAgentModelAgentItem | undefined {
    return agents().find((agent) => agent.name === name);
  }

  function applyEdit(name: string, edits: readonly FrontmatterKeyEdit[], actionLabel: string): ManageAgentModelApplyResult {
    const failed = edits.find((edit): edit is Extract<FrontmatterKeyEdit, { ok: false }> => !edit.ok);
    if (failed) return { ok: false, message: failed.message };
    const changed = edits.some((edit) => edit.ok && edit.changed);
    if (!changed) {
      return { ok: true, message: `Agent "${name}" ${actionLabel}; no change was needed.` };
    }
    const agent = findAgent(name);
    if (!agent) {
      return { ok: false, message: `Unknown agent: ${name}` };
    }
    const last = edits[edits.length - 1];
    if (!last?.ok) {
      return { ok: false, message: "frontmatter edit failed" };
    }
    try {
      writeFileSync(agent.filePath, last.content, "utf-8");
    } catch (error) {
      return { ok: false, message: `Could not write ${agent.filePath}: ${error instanceof Error ? error.message : String(error)}` };
    }
    clearAgentDiscoveryCache();
    return { ok: true, message: `Agent "${name}" ${actionLabel}.` };
  }

  return {
    async listAgents() {
      return agents();
    },
    async listModels() {
      return models();
    },
    async listThinkingLevels(reference) {
      const model = findModel(reference);
      if (!model) return [];
      const levels = supportedThinkingLevels(model);
      return levels.map((level) => ({ level, label: level }));
    },
    async setModel(name, reference, thinking, _signal) {
      const agent = findAgent(name);
      if (!agent) return { ok: false, message: `Unknown agent: ${name}` };
      let content: string;
      try {
        content = readFileSync(agent.filePath, "utf-8");
      } catch (error) {
        return { ok: false, message: `Could not read ${agent.filePath}: ${error instanceof Error ? error.message : String(error)}` };
      }
      const modelEdit = setFrontmatterKey(content, "model", reference);
      if (!modelEdit.ok) return { ok: false, message: modelEdit.message };
      const edits: FrontmatterKeyEdit[] = [modelEdit];
      if (thinking) {
        const thinkingEdit = setFrontmatterKey(modelEdit.content, "thinking", thinking);
        if (!thinkingEdit.ok) return { ok: false, message: thinkingEdit.message };
        edits.push(thinkingEdit);
      }
      return applyEdit(name, edits, `model set to ${reference}${thinking ? `, thinking ${thinking}` : ""}`);
    },
    async removeModel(name, _signal) {
      const agent = findAgent(name);
      if (!agent) return { ok: false, message: `Unknown agent: ${name}` };
      let content: string;
      try {
        content = readFileSync(agent.filePath, "utf-8");
      } catch (error) {
        return { ok: false, message: `Could not read ${agent.filePath}: ${error instanceof Error ? error.message : String(error)}` };
      }
      const modelEdit = removeFrontmatterKey(content, "model");
      if (!modelEdit.ok) return { ok: false, message: modelEdit.message };
      const thinkingEdit = removeFrontmatterKey(modelEdit.content, "thinking");
      if (!thinkingEdit.ok) return { ok: false, message: thinkingEdit.message };
      return applyEdit(name, [modelEdit, thinkingEdit], "model removed");
    },
    async getGlobalModel() {
      const configPath = settingsConfigPath();
      const settings = resolveSettingsForProject(cwd);
      return { model: settings.agents.model, thinking: settings.agents.thinking, configPath };
    },
    async setGlobalModel(reference, thinking, _signal) {
      const configPath = settingsConfigPath();
      try {
        const config = readSettingsConfig(configPath);
        const agents = typeof config.agents === "object" && config.agents !== null && !Array.isArray(config.agents)
          ? { ...(config.agents as Record<string, unknown>) }
          : {};
        const sameModel = agents.model === reference;
        const sameThinking = agents.thinking === thinking;
        if (sameModel && sameThinking) {
          return { ok: true, message: `Global agent model already set to ${reference}${thinking ? `, thinking ${thinking}` : ""}; no change was needed.` };
        }
        agents.model = reference;
        if (thinking) agents.thinking = thinking;
        else delete agents.thinking;
        writeSettingsConfig(configPath, { ...config, agents });
      } catch (error) {
        return { ok: false, message: `Could not write ${configPath}: ${error instanceof Error ? error.message : String(error)}` };
      }
      clearSettingsCache();
      return { ok: true, message: `Global agent model set to ${reference}${thinking ? `, thinking ${thinking}` : ""}.` };
    },
    async removeGlobalModel(_signal) {
      const configPath = settingsConfigPath();
      try {
        const config = readSettingsConfig(configPath);
        const agents = typeof config.agents === "object" && config.agents !== null && !Array.isArray(config.agents)
          ? { ...(config.agents as Record<string, unknown>) }
          : {};
        if (!("model" in agents) && !("thinking" in agents)) {
          return { ok: true, message: "No global agent model or thinking is configured; no change was needed." };
        }
        delete agents.model;
        delete agents.thinking;
        writeSettingsConfig(configPath, { ...config, agents });
      } catch (error) {
        return { ok: false, message: `Could not write ${configPath}: ${error instanceof Error ? error.message : String(error)}` };
      }
      clearSettingsCache();
      return { ok: true, message: "Global agent model removed." };
    },
    async cancel() {
      await undefined;
    },
  };
}
