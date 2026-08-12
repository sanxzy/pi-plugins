export { createAgentDiscovery } from "./infrastructure/agents/discovery.ts";
export {
  createReferenceCatalog,
  type ReferenceCatalogOperation,
  type ReferenceCatalogOperationError,
  type ReferenceCatalogOperationOptions,
  type ReferenceCatalogOperationResult,
  type ReferenceGitOperationInput,
  type ReferenceAvailability,
  type ReferenceMaterializationStatus,
  type ReferenceCatalog,
  type ReferenceCatalogEntry,
  type ReferenceCatalogOptions,
  type ReferenceCatalogReadResult,
} from "./infrastructure/references/catalog.ts";
export { createGoalPool, getGoalPool, normalizeGoalCwd, type GoalPool, type GoalCreateInput, type GoalMutationResult, type GoalDeliveryBinding, type GoalTimerHandle } from "./infrastructure/goals/goal-pool.ts";
export { createGoalStore, foldGoalLog, type GoalStore } from "./infrastructure/goals/goal-store.ts";
export { resolveChildTools, spawnChildSession } from "./infrastructure/pi-sdk/child-session.ts";
export {
  attachAgentSessionLiveFeed,
  liveStatusForSession,
  mapAgentSessionEvent,
} from "./infrastructure/pi-sdk/child-live.ts";
export { observeChildStatus, type ChildStatus, type ChildStatusInput } from "./infrastructure/pi-sdk/child-status.ts";
export { backgroundModeError, formatBackgroundResult, runBackgroundJob } from "./infrastructure/pool/background.ts";
export { getChildPool, type ChildPool } from "./infrastructure/pool/child-pool.ts";
export { createConcurrencyGate, type ConcurrencyGate } from "./infrastructure/pool/concurrency-gate.ts";
export { createDeliveryCoordinator, type DeliveryCoordinator } from "./infrastructure/pool/delivery.ts";
export { createInterruptionSweep, interruptRunningJobs } from "./infrastructure/pool/interruption.ts";
export { createRegistry, foldLog, recordNewJob, type Registry } from "./infrastructure/registry/registry.ts";
export { createScopedRegistry, scopedRegistryForSession, type ScopedRegistry } from "./infrastructure/registry/scoped-registry.ts";
export { prepareResumeSessionFile } from "./infrastructure/sessions/resume-file.ts";
export { scopeDescendants, scopeRegistry, sessionTreeJobs, type ScopedSessionRow, type ScopeRegistry } from "./infrastructure/sessions/scope.ts";
export {
  assertSessionId,
  childSessionDir,
  childTranscriptDir,
  childTranscriptFile,
  goalsFile,
  pendingDeliveryFile,
  rootSessionDir,
  runtimeDir,
  scopedRegistryFile,
  scopedSessionsDir,
  sessionDir,
  sessionRegistryFile,
} from "./shared/paths.ts";