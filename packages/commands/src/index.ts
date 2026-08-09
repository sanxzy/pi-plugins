export { registerSessionEvents } from "./registrations/session-events.ts";
export { registerLifecycleGates } from "./registrations/lifecycle-gates.ts";
export { registerTelegramSetup, type TelegramSetupRegistrationDeps } from "./registrations/telegram-setup.ts";
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
  registerTelegramInbound,
  type TelegramInboundDeps,
} from "./registrations/telegram-inbound.ts";
