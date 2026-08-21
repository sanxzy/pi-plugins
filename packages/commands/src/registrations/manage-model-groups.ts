import type { ExtensionAPI, ExtensionCommandContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { supportedThinkingLevels, type ThinkingCapableModel } from "@xzy-ai/core";
import { COMMAND_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { ManageModelGroupsWizard, type ManageModelGroupsResult } from "@xzy-ai/tui";
import type {
  ManageModelGroupsApplyResult,
  ManageModelGroupsController,
  ManageModelGroupsGroupInput,
  ManageModelGroupsGroupItem,
  ManageModelGroupsModelItem,
} from "@xzy-ai/tui";
import {
  deriveGroupContextWindow,
  getModelGroups,
  getQuarantineMap,
  saveModelGroups,
  type ModelGroup,
  type ModelGroupEntry,
} from "@xzy-ai/runtime";
import { readFileSync, writeFileSync } from "node:fs";

export interface ManageModelGroupsControllerOptions {
  modelRegistry: Pick<ModelRegistry, "getAvailable">;
}

interface RegistryModel extends ThinkingCapableModel {
  readonly provider: string;
  readonly id: string;
}

const QUARANTINE_MIN = 1;
const QUARANTINE_MAX = 60;

/** Group display id: deterministic first 8 characters of the group name, lower-cased. */
function groupIdFor(name: string, groups: readonly ModelGroup[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "group";
  let id = base;
  let n = 1;
  const taken = new Set(groups.map((g) => g.id));
  while (taken.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  return id;
}

function readConfig(filePath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeConfig(filePath: string, value: Record<string, unknown>): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function modelRef(model: RegistryModel): string {
  return `${model.provider}/${model.id}`;
}

/** Convert a group entry + registry into the wizard's group row shape. */
function toGroupItem(
  group: ModelGroup,
  activeGroupId: string | undefined,
  registry: readonly RegistryModel[],
): ManageModelGroupsGroupItem {
  const now = Date.now();
  const catalog = registry.map((m) => ({ provider: m.provider, id: m.id, contextWindow: (m as unknown as { contextWindow?: number }).contextWindow }));
  const contextWindow = deriveGroupContextWindow(group, catalog);
  return {
    id: group.id,
    name: group.name,
    mode: group.mode,
    quarantineMinutes: group.quarantineMinutes,
    models: group.models.map((entry) => {
      const expiry = getQuarantineMap().get(entry.ref);
      return {
        ref: entry.ref,
        thinking: entry.thinking,
        reasoning: entry.reasoning,
        ...(expiry !== undefined && expiry > now ? { quarantinedForMs: expiry - now } : {}),
      };
    }),
    contextWindow,
    active: group.id === activeGroupId,
  };
}

function validateGroupInput(input: ManageModelGroupsGroupInput): string | undefined {
  if (!input.name || input.name.trim().length === 0) return "Group name must not be empty.";
  if (input.mode !== "fallback" && input.mode !== "round-robin") return "Mode must be fallback or round-robin.";
  if (!Number.isInteger(input.quarantineMinutes) || input.quarantineMinutes < QUARANTINE_MIN || input.quarantineMinutes > QUARANTINE_MAX) {
    return `Quarantine minutes must be between ${QUARANTINE_MIN} and ${QUARANTINE_MAX}.`;
  }
  if (input.contextWindow !== undefined && (!Number.isInteger(input.contextWindow) || input.contextWindow < 1)) {
    return "Context window must be a positive whole number of tokens, or blank for the automatic minimum.";
  }
  if (input.models.length === 0) return "A group needs at least one model.";
  for (const model of input.models) {
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(model.ref)) return `Invalid model reference: ${model.ref}`;
  }
  return undefined;
}

/**
 * Controller for `/c2-manage-model-groups`.
 *
 * Groups persist to the home-scoped `pi-c2/model-groups.json` store. Activating
 * a group removes the global `agents.model`/`agents.thinking` keys so the group
 * is the single authority for the next turn (mirroring the reverse: picking a
 * single model through `/c2-manage-agent-model` clears `activeGroupId`).
 */
export function createManageModelGroupsController(options: ManageModelGroupsControllerOptions): ManageModelGroupsController {
  const { modelRegistry } = options;

  function registry(): readonly RegistryModel[] {
    return modelRegistry.getAvailable() as readonly RegistryModel[];
  }

  function entriesFor(input: ManageModelGroupsGroupInput): ModelGroupEntry[] {
    return input.models.map((model) => {
      const found = registry().find((m) => modelRef(m) === model.ref);
      return {
        ref: model.ref,
        ...(model.thinking ? { thinking: model.thinking } : {}),
        ...(found ? { reasoning: found.reasoning } : {}),
      };
    });
  }

  return {
    async listGroups() {
      const file = getModelGroups();
      return file.groups.map((group) => toGroupItem(group, file.activeGroupId, registry()));
    },
    async listModels() {
      return registry()
        .map((model) => ({ provider: model.provider, id: model.id, reference: modelRef(model), reasoning: model.reasoning } satisfies ManageModelGroupsModelItem))
        .sort((a, b) => a.reference.localeCompare(b.reference));
    },
    async listThinkingLevels(reference) {
      const model = registry().find((m) => modelRef(m) === reference);
      if (!model) return [];
      return supportedThinkingLevels(model).map((level) => ({ level, label: level }));
    },
    async createGroup(input) {
      const error = validateGroupInput(input);
      if (error) return { ok: false, message: error };
      const file = getModelGroups();
      if (file.groups.some((g) => g.name.toLowerCase() === input.name.trim().toLowerCase())) {
        return { ok: false, message: `A group named "${input.name.trim()}" already exists.` };
      }
      const group: ModelGroup = {
        id: groupIdFor(input.name.trim(), file.groups),
        name: input.name.trim(),
        mode: input.mode,
        quarantineMinutes: input.quarantineMinutes,
        ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
        models: entriesFor(input),
      };
      const saved = saveModelGroups({ groups: [...file.groups, group], activeGroupId: file.activeGroupId });
      if (!saved.ok) return { ok: false, message: saved.error };
      return { ok: true, message: `Group "${group.name}" created.` };
    },
    async updateGroup(id, input) {
      const error = validateGroupInput(input);
      if (error) return { ok: false, message: error };
      const file = getModelGroups();
      const existing = file.groups.find((g) => g.id === id);
      if (!existing) return { ok: false, message: `Unknown group: ${id}` };
      const duplicate = file.groups.some((g) => g.id !== id && g.name.toLowerCase() === input.name.trim().toLowerCase());
      if (duplicate) return { ok: false, message: `A group named "${input.name.trim()}" already exists.` };
      const updated: ModelGroup = {
        id,
        name: input.name.trim(),
        mode: input.mode,
        quarantineMinutes: input.quarantineMinutes,
        ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
        models: entriesFor(input),
      };
      const saved = saveModelGroups({
        groups: file.groups.map((g) => (g.id === id ? updated : g)),
        activeGroupId: file.activeGroupId,
      });
      if (!saved.ok) return { ok: false, message: saved.error };
      return { ok: true, message: `Group "${updated.name}" updated.` };
    },
    async deleteGroup(id) {
      const file = getModelGroups();
      const existing = file.groups.find((g) => g.id === id);
      if (!existing) return { ok: false, message: `Unknown group: ${id}` };
      const saved = saveModelGroups({
        groups: file.groups.filter((g) => g.id !== id),
        activeGroupId: file.activeGroupId === id ? undefined : file.activeGroupId,
      });
      if (!saved.ok) return { ok: false, message: saved.error };
      return { ok: true, message: `Group "${existing.name}" deleted.` };
    },
    async activateGroup(id) {
      const file = getModelGroups();
      const existing = file.groups.find((g) => g.id === id);
      if (!existing) return { ok: false, message: `Unknown group: ${id}` };
      const saved = saveModelGroups({ groups: file.groups, activeGroupId: id });
      if (!saved.ok) return { ok: false, message: saved.error };
      return { ok: true, message: `Active model group set to "${existing.name}".` };
    },
  };
}

export { groupIdFor };
export const _test = { readConfig, writeConfig, modelRef, toGroupItem, validateGroupInput };

/** Register the interactive model-group management wizard command. */
export function registerManageModelGroupsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("c2-manage-model-groups", {
    description: "Manage model groups (create/edit/delete/activate)",
    async handler(_args: string, ctx: ExtensionCommandContext): Promise<void> {
      return processWithLog({ operation: COMMAND_OPERATIONS.MANAGE_AGENT_MODEL }, async () => {
        if (ctx.mode !== "tui" || !ctx.hasUI) {
          ctx.ui.notify("Model group management requires an interactive TUI session", "warning");
          return;
        }
        const controller = createManageModelGroupsController({ modelRegistry: ctx.modelRegistry });
        const result = await ctx.ui.custom<ManageModelGroupsResult>((tui, theme, _keybindings, done) => {
          return new ManageModelGroupsWizard({
            tui,
            theme: { fg: (color, text) => theme.fg(color as never, text) },
            controller,
            done,
            signal: ctx.signal,
          });
        });
        if (result.status === "saved") ctx.ui.notify(result.message, "info");
        else ctx.ui.notify("Model group management cancelled", "info");
      });
    },
  });
}