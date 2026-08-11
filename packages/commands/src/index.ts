export { registerSessionEvents } from "./registrations/session-events.ts";
export { registerLifecycleGates } from "./registrations/lifecycle-gates.ts";
export { registerGoalCommand, expandTelegramGoalCommand, GOAL_WORKFLOW_PROMPT } from "./registrations/goal-command.ts";
export { registerTelegramSetup, type TelegramSetupRegistrationDeps } from "./registrations/telegram-setup.ts";
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
