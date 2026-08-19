export { registerSessionEvents, type SessionEventsOptions } from "./registrations/session-events.ts";
export { registerContextAutoCompact } from "./registrations/context-auto-compact.ts";
export {
  notifyHost,
  registerNotifyEntry,
  appendNotifyEntry,
  NOTIFY_ENTRY_TYPE,
  notifyEntryRenderer,
  type NotifyEntryData,
} from "./registrations/notify-entry.ts";
export { registerPonytailSetup } from "./registrations/ponytail-setup.ts";
export { registerSystemPrompt } from "./registrations/system-prompt.ts";
export {
  clearSessionReload,
  markSessionReload,
  takeSessionReload,
} from "./registrations/session-events.ts";
export { registerLifecycleGates } from "./registrations/lifecycle-gates.ts";
export { registerGoalCommand, expandTelegramGoalCommand, GOAL_WORKFLOW_PROMPT } from "./registrations/goal-command.ts";
export { registerTelegramSetup, type TelegramSetupRegistrationDeps } from "./registrations/telegram-setup.ts";
export { registerReferencesSetup } from "./registrations/references-setup-command.ts";
export { registerManageAgentModel } from "./registrations/manage-agent-model-command.ts";
export { createManageAgentModelController } from "./registrations/manage-agent-model.ts";
export type { ManageAgentModelControllerOptions } from "./registrations/manage-agent-model.ts";
export { registerManageGoal } from "./registrations/manage-goal-command.ts";
export { createManageGoalController } from "./registrations/manage-goal.ts";
export type { ManageGoalControllerOptions } from "./registrations/manage-goal.ts";
export {
  createReferencesSetupController,
  type ReferencesSetupController,
  type ReferencesSetupItem,
  type ReferencesLocalInput,
  type ReferencesGitInput,
  type ReferencesMutationResult,
  type ReferencesOperationResult,
  type ReferencesSetupControllerOptions,
} from "./registrations/references-setup.ts";
export { registerTelegramClear } from "./registrations/telegram-clear.ts";
export {
  clearTelegramProjectManager,
  clearTelegramProjectManagers,
  getTelegramProjectManager,
  getTelegramProjectManagerIfPresent,
  type TelegramProjectManagerOptions,
} from "./registrations/telegram-project.ts";
export {
  clearTelegramLifecycleRegistry,
  registerTelegramLifecycle,
  type TelegramLifecycleRegistrationDeps,
} from "./registrations/telegram-lifecycle.ts";
export {
  refreshTelegramInbound,
  registerTelegramInbound,
  type TelegramInboundDeps,
} from "./registrations/telegram-inbound.ts";
export {
  clearTelegramCommandContext,
  clearTelegramControlState,
  dispatchTelegramControl,
  getTelegramCommandContext,
  setTelegramCommandContext,
  type TelegramControlDispatchOptions,
} from "./registrations/telegram-controls.ts";
export {
  createDefaultTelegramCommandExpander,
  createTelegramCommandExpander,
  type TelegramCommandExpander,
  type TelegramCommandExpanderOptions,
} from "./registrations/telegram-commands.ts";
