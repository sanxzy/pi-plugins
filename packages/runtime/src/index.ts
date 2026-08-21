export { createAgentDiscovery, createCachedAgentDiscovery, clearAgentDiscoveryCache } from "./infrastructure/agents/discovery.ts";
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
export { currentProcessIdentity, processStartTime, type ProcessIdentity } from "./infrastructure/manifests/process-identity.ts";
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
export { createChildSessionManager, resolveChildTools, resolveChildCustomTools, spawnChildSession } from "./infrastructure/pi-sdk/child-session.ts";
export { maxAgentDepth } from "./shared/pi-c2-config.ts";
export {
  canonicalizeWriteEditTarget,
  initializeChildPonytailState,
  loadPonytailState,
  mutatePonytailState,
  ponytailStateExists,
  pruneExpiredTickets,
  serializePonytailMutation,
  writePonytailState,
  type PonytailPersistence,
  type PonytailState,
  type PonytailTicket,
} from "./infrastructure/ponytail/state.ts";
export {
  DEFAULT_THINKING_REQUIRED_TURNS,
  THINKING_REQUIRED_TURNS_MAX,
  THINKING_REQUIRED_TURNS_MIN,
  initializeChildThinkingState,
  loadThinkingState,
  mutateThinkingState,
  parseRequiredTurns,
  thinkingStateExists,
  serializeThinkingMutation,
  writeThinkingState,
  thinkingStatePath,
  type ThinkingPersistence,
  type ThinkingState,
} from "./infrastructure/thinking/state.ts";
export { resolveTicketScopes, type ResolveTicketScopeError, type ResolveTicketScopesInput, type ResolvedTicketScope } from "./infrastructure/ponytail/scopes.ts";
export { isWithinScope, isDescendantScope } from "./infrastructure/ponytail/containment.ts";
export { clearSettingsCache, migrateLegacyGoalLimit, resolveSettings, resolveSettingsForProject, settingsConfigPath, bootstrapSettingsConfig, type AgentSettings, type ChannelSettings, type CommandSettings, type McpSettings, type PonytailSettings, type ResolvedSettings, type RuntimeSettings, type WebSettings } from "./shared/settings.ts";
export { getChildExtensionFactories, registerChildExtensionFactory, getChildPonytailTools, registerChildPonytailTools, type ChildPonytailTools, getChildThinkingTool, registerChildThinkingTool, type ChildThinkingTool } from "./infrastructure/pi-sdk/child-extensions.ts";
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
export { abortJobTree, createInterruptionSweep, interruptRunningJobs } from "./infrastructure/pool/interruption.ts";
export { createRegistry, foldLog, recordNewJob, type Registry } from "./infrastructure/registry/registry.ts";
export { createScopedRegistry, scopedRegistryForSession, type ScopedRegistry } from "./infrastructure/registry/scoped-registry.ts";
export { createAgentEventRegistry, canonicalJobId, MAX_RETAINED_TERMINAL_AGENTS, type AgentEventRegistry } from "./infrastructure/registry/agent-event-registry.ts";
export { prepareResumeSessionFile } from "./infrastructure/sessions/resume-file.ts";
export { scopeDescendants, scopeRegistry, sessionTreeJobs, type ScopedSessionRow, type ScopeRegistry } from "./infrastructure/sessions/scope.ts";
export { createHostSwapController, type HostSwapController, type HostSwapTarget, type BufferedOutput } from "./infrastructure/host-swap/host-swap.ts";
export { homeModelGroupsFile, homeModelGroupsFilePath, getModelGroups, saveModelGroups, clearModelGroupsCache, resolveActiveModel, getActiveGroup, clearRoundRobinPointers, deriveGroupContextWindow, clearActiveGroup, installModelGroupHostApi, type ModelGroup, type ModelGroupEntry, type ModelGroupsFile, type ModelGroupMode, type ModelGroupHostApi, type ModelGroupHostItem, type ModelGroupHostActivation } from "./infrastructure/model-groups/store.ts";
export { quarantineModel, isQuarantined, clearQuarantine, getQuarantineMap } from "./infrastructure/model-groups/quarantine.ts";
export { runWithModelGroupFallback, type AttemptResult, type FallbackResult } from "./infrastructure/model-groups/fallback.ts";
export {
  BUILTIN_THEME_IDS,
  BUILTIN_THEME_PROFILES,
  DEFAULT_THEME_ID,
  clearThemeLibraryCache,
  cloneThemeLibrary,
  cloneThemeProfile,
  getBuiltinThemeFallback,
  getBuiltinThemeProfiles,
  getThemeProfile,
  getThemes,
  isValidThemeLibrary,
  listThemeLibraryBackups,
  loadThemeLibrary,
  loadThemes,
  parseThemeLibrary,
  readThemeLibrary,
  readThemeLibraryBackup,
  resolveThemeProfile,
  themeLibraryPath,
  validateThemeLibrary,
  type ThemeLibraryPersistence,
} from "./infrastructure/themes/library.ts";
export {
  THEME_BACKGROUND_TOKENS,
  THEME_COLOR_TOKENS,
  THEME_EXPORT_TOKENS,
  THEME_FOREGROUND_TOKENS,
  type ThemeBackgroundToken,
  type ThemeColorMode,
  type ThemeColorToken,
  type ThemeColorValue,
  type ThemeColors,
  type ThemeExportColors,
  type ThemeExportToken,
  type ThemeForegroundToken,
  type ThemeLibrary,
  type ThemeProfile,
  type ThemeVars,
} from "./infrastructure/themes/types.ts";
export {
  assertSessionId,
  canonicalProjectRoot,
  decodeProjectId,
  encodeProjectId,
  ensurePrivateDirectory,
  childSessionPaths,
  canonicalStorageJobId,
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
  homePonytailSessionDir,
  homePonytailStateFile,
  homeThinkingSessionDir,
  homeThinkingStateFile,
  homeThemesFile,
  homeProjectManifestFile,
  homeRoot,
  homeRootBase,
  homeSessionDir,
  homeSessionDirFromRoot,
  homeSessionManifestFile,
  MODEL_GROUPS_FILE_NAME,
  THEMES_BACKUP_PREFIX,
  THEMES_BACKUP_SUFFIX,
  THEMES_FILE_NAME,
  homeProjectsDir,
  readPrivateJson,
  writePrivateJson,
  writePrivateText,
  AGENT_MANIFEST_FILE_NAME,
  EVENTS_FILE_NAME,
  ERRORS_FILE_NAME,
  GOALS_FILE_NAME,
  PONYTAIL_FILE_NAME,
  PONYTAIL_BACKUP_PREFIX,
  PONYTAIL_BACKUP_SUFFIX,
  THINKING_FILE_NAME,
  THINKING_BACKUP_PREFIX,
  THINKING_BACKUP_SUFFIX,
  PENDING_DELIVERY_FILE_NAME,
  PROJECT_MANIFEST_FILE_NAME,
  SESSION_MANIFEST_FILE_NAME,
  TRANSCRIPT_FILE_NAME,
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
