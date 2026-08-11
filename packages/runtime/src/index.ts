export { createAgentDiscovery } from "./infrastructure/agents/discovery.ts";
export {
  canonicalAgentId,
  createAgentManifestStore,
  finishRootSession,
  foldAgentEvents,
  readAgentManifest,
  readProjectManifest,
  readSessionManifest,
  startRootSession,
  writeProjectManifest,
  type AgentLifecycleEvent,
  type AgentManifest,
  type AgentManifestStore,
  type CreateAgentManifestStoreInput,
  type FinishRootSessionInput,
  type FinishRootSessionResult,
  type ProjectManifest,
  type SessionManifest,
  type StartRootSessionInput,
  type StartRootSessionResult,
} from "./infrastructure/manifests/manifests.ts";
export { createGoalPool, getGoalPool, normalizeGoalCwd, type GoalPool, type GoalCreateInput, type GoalMutationResult, type GoalDeliveryBinding, type GoalTimerHandle } from "./infrastructure/goals/goal-pool.ts";
export { createGoalStore, foldGoalLog, type GoalStore } from "./infrastructure/goals/goal-store.ts";
export { createChildSessionManager, resolveChildTools, spawnChildSession, copySessionFile } from "./infrastructure/pi-sdk/child-session.ts";
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
  canonicalProjectRoot,
  decodeProjectId,
  encodeProjectId,
  ensurePrivateDirectory,
  childSessionPaths,
  homeAgentDir,
  homeAgentDirectory,
  homeAgentErrorsFile,
  homeAgentEventsFile,
  homeAgentManifestFile,
  homeAgentTranscriptFile,
  homeChannelConfigFile,
  homeChannelOwnerFile,
  homeChannelRuntimeFile,
  homeDailyErrorFile,
  homeDailyEventFile,
  homeGoalFile,
  homeProjectDir,
  homeProjectDirFromRoot,
  homeProjectManifestFile,
  homeRoot,
  homeRootBase,
  homeSessionDir,
  homeSessionDirFromRoot,
  homeSessionManifestFile,
  homeProjectsDir,
  readPrivateJson,
  writePrivateJson,
  writePrivateText,
  AGENT_MANIFEST_FILE_NAME,
  EVENTS_FILE_NAME,
  ERRORS_FILE_NAME,
  GOALS_FILE_NAME,
  PROJECT_MANIFEST_FILE_NAME,
  SESSION_MANIFEST_FILE_NAME,
  TRANSCRIPT_FILE_NAME,
  childSessionDir,
  childTranscriptDir,
  childTranscriptFile,
  goalsFile,
  rootSessionDir,
  runtimeDir,
  scopedRegistryFile,
  scopedSessionsDir,
  sessionDir,
  sessionRegistryFile,
} from "./shared/paths.ts";