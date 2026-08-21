/**
 * Central registry of `processWithLog` operation identifiers.
 *
 * Every meaningful processing boundary in pi-c2 uses one of these constants
 * as its `operation`. Centralizing them keeps operation names stable and
 * searchable (single source of truth), avoids typos across the many call sites,
 * and makes log rerouting/analysis predictable.
 *
 * Naming convention: `<domain>.<verb>` with camelCase verbs (e.g.
 * `mcp.managerStart`). Domains are the processing-family (session, agent,
 * goal, registry, telegram, command, tool). `normalizeOperation` in `index.ts`
 * preserves this exact casing so persisted operation ids match the constants
 * 1:1; it is only a safety net for unknowable dynamic operations, not a
 * substitute for these constants.
 */

export const SESSION_OPERATIONS = {
  START: "session.start",
  STOP: "session.stop",
  TURN_START: "session.turnStart",
  BEFORE_SWITCH: "session.beforeSwitch",
  COMPACT: "session.compact",
  /** Apply the configured percentage-based auto-compaction threshold to a session's settings. */
  COMPACT_THRESHOLD_APPLY: "session.compactThresholdApply",
  /** Compaction lifecycle event (session_compact: reason, willRetry, fromExtension, tokensBefore). */
  COMPACT_LIFECYCLE: "session.compactLifecycle",
  /** Per-message threshold crossing check (message_end: role, usage estimate, threshold, contextWindow). */
  COMPACT_THRESHOLD_CHECK: "session.compactThresholdCheck",
  CLEANUP: "session.cleanup",
} as const;

export const AGENT_OPERATIONS = {
  LIFECYCLE: "agent.lifecycle",
  BEFORE_START: "agent.beforeStart",
  START: "agent.start",
  RUN_BACKGROUND: "agent.runBackground",
  STATUS: "agent.status",
  LIST: "agent.list",
  CANCEL: "agent.cancel",
} as const;

export const GOAL_OPERATIONS = {
  CREATE: "goal.create",
  PAUSE: "goal.pause",
  RESUME: "goal.resume",
  UPDATE_INTERVAL: "goal.updateInterval",
  CLEAR: "goal.clear",
  TICK: "goal.tick",
  BIND: "goal.bind",
  SHUTDOWN: "goal.shutdown",
  CLEAR_ACTIVE: "goal.clearActive",
  PAUSE_ALL: "goal.pauseAll",
  RESUME_DELIVERY: "goal.resumeDelivery",
  BEGIN_CONFIRMATION: "goal.beginConfirmation",
  CONTINUE_REPLACEMENT: "goal.continueReplacement",
  TAKE_REPLACEMENT: "goal.takeReplacement",
} as const;

export const REGISTRY_OPERATIONS = {
  CREATE_JOB: "registry.createJob",
  UPDATE_JOB: "registry.updateJob",
  APPEND: "registry.append",
  PRUNE: "registry.prune",
  FOLD: "registry.fold",
  AGENT_CREATE: "registry.agentCreate",
  AGENT_UPDATE: "registry.agentUpdate",
  AGENT_PRUNE: "registry.agentPrune",
  AGENT_LOAD: "registry.agentLoad",
  AGENT_ENSURE_SESSION: "registry.agentEnsureSession",
} as const;

export const PERSISTENCE_OPERATIONS = {
  DELIVERY_LOAD: "persistence.deliveryLoad",
  DELIVERY_PERSIST: "persistence.deliveryPersist",
  DELIVERY_REGISTER: "persistence.deliveryRegister",
  DELIVERY_UNREGISTER: "persistence.deliveryUnregister",
  DELIVERY_REBIND: "persistence.deliveryRebind",
  DELIVERY_RESULT: "persistence.deliveryResult",
  MANIFEST_PROJECT_WRITE: "persistence.manifestProjectWrite",
  GOAL_APPEND: "persistence.goalAppend",
  MANIFEST_START: "persistence.manifestStart",
  MANIFEST_FINISH: "persistence.manifestFinish",
  MANIFEST_AGENT_CREATE: "persistence.agentManifestCreate",
  MANIFEST_AGENT_UPDATE: "persistence.agentManifestUpdate",
  SESSION_RESUME_PREPARE: "persistence.sessionResumePrepare",
} as const;

export const CHANNEL_OPERATIONS = {
  OUTBOUND_SEND: "channel.outboundSend",
  OUTBOUND_REACT: "channel.outboundReact",
  OUTBOUND_MEDIA: "channel.outboundMedia",
  MEDIA_DOWNLOAD: "channel.mediaDownload",
  MEDIA_RESOLVE: "channel.mediaResolve",
  OUTBOUND_CHOICES: "channel.outboundChoices",
  INBOUND_HANDLE: "channel.inboundHandle",
  INBOUND_DRAIN: "channel.inboundDrain",
  MANAGER_START: "channel.managerStart",
  MANAGER_STOP: "channel.managerStop",
  MANAGER_REPLACE: "channel.managerReplace",
  STATE_WRITE: "channel.stateWrite",
  STATE_CLEAR: "channel.stateClear",
  OWNER_ACQUIRE: "channel.ownerAcquire",
  OWNER_RELEASE: "channel.ownerRelease",
  CLEANUP: "channel.cleanup",
  LIFECYCLE_START: "channel.lifecycleStart",
  LIFECYCLE_STOP: "channel.lifecycleStop",
} as const;

export const TELEGRAM_OPERATIONS = {
  TRANSPORT_START: "telegram.transportStart",
  TRANSPORT_STOP: "telegram.transportStop",
  LIFECYCLE_START: "telegram.lifecycleStart",
  LIFECYCLE_STOP: "telegram.lifecycleStop",
  INBOUND: "telegram.inbound",
  CHOICE_CONSUME: "telegram.choiceConsume",
  CONTROLS_DISPATCH: "telegram.controlsDispatch",
  REACTION_ACK: "telegram.reactionAck",
  SEND: "telegram.send",
} as const;

export const PONYTAIL_OPERATIONS = {
  ENFORCE: "ponytail.enforce",
} as const;

export const COMMAND_OPERATIONS = {
  SETUP_PONYTAIL: "command.setupPonytail",
  SETUP_THINKING: "command.setupThinking",
  GOAL_COMMAND: "command.goal",
  SETUP_CHANNEL: "command.setupChannel",
  CLEAR_CHANNEL: "command.clearChannel",
  SETUP_REFERENCES: "command.setupReferences",
  MANAGE_AGENT_MODEL: "command.manageAgentModel",
  MANAGE_GOAL: "command.manageGoal",
  MANAGE_COMPACT_THRESHOLD: "command.manageCompactThreshold",
  CONTROLS: "command.controls",
} as const;

export const MCP_OPERATIONS = {
  LIFECYCLE_START: "mcp.lifecycleStart",
  LIFECYCLE_STOP: "mcp.lifecycleStop",
  MANAGER_START: "mcp.managerStart",
  MANAGER_STOP: "mcp.managerStop",
  MANAGER_CLOSE: "mcp.managerClose",
  STDIO_START: "mcp.stdioStart",
  STDIO_SEND: "mcp.stdioSend",
  STDIO_CLOSE: "mcp.stdioClose",
  PROCESS_TERMINATE: "mcp.processTerminate",
  RELOAD: "mcp.reload",
  RECONNECT: "mcp.reconnect",
  RECONCILE: "mcp.reconcile",
  CONNECT: "mcp.connect",
  CONNECT_REMOTE: "mcp.connectRemote",
  DISCONNECT: "mcp.disconnect",
  REFRESH_CATALOG: "mcp.refreshCatalog",
  CALL_TOOL: "mcp.callTool",
  GET_PROMPT: "mcp.getPrompt",
  READ_RESOURCE: "mcp.readResource",
  INVOKE_TOOL: "mcp.invokeTool",
  HANDLE_PROMPT: "mcp.handlePrompt",
  RESOURCE_LIST: "mcp.resourceList",
  RESOURCE_READ: "mcp.resourceRead",
  COMMAND: "mcp.command",
  AUTH_STORE: "mcp.authStore",
} as const;

export const TOOL_OPERATIONS = {
  FOOTER_START: "tool.footerStart",
  FOOTER_STOP: "tool.footerStop",
  AGENT_EXECUTE: "tool.agentExecute",
  CANCEL_EXECUTE: "tool.cancelExecute",
  TELEGRAM_EXECUTE: "tool.telegramExecute",
  GOALS_EXECUTE: "tool.goalsExecute",
  STATUS_EXECUTE: "tool.statusExecute",
  JOBS_EXECUTE: "tool.jobsExecute",
  QUESTION_EXECUTE: "tool.questionExecute",
  WEB_SEARCH_EXECUTE: "tool.webSearchExecute",
  WEB_FETCH_EXECUTE: "tool.webFetchExecute",
  WIKI_EXECUTE: "tool.wikiExecute",
  KNOWLEDGE_SEARCH_EXECUTE: "tool.knowledgeSearchExecute",
  AGENT_LIST_EXECUTE: "tool.agentListExecute",
  WRITE_EXECUTE: "tool.writeExecute",
  EDIT_EXECUTE: "tool.editExecute",
  WRITE_MARKDOWN_EXECUTE: "tool.writeMarkdownExecute",
  WRITE_MARKDOWN_REJECT: "tool.writeMarkdownReject",
  EDIT_MARKDOWN_EXECUTE: "tool.editMarkdownExecute",
  EDIT_MARKDOWN_REJECT: "tool.editMarkdownReject",
  DEEP_THINK_EXECUTE: "tool.deepThinkExecute",
} as const;

/**
 * Flattened union of every known operation identifier. Mirror type keeps the
 * runtime values and the compile-time union in one place.
 */
export const ALL_OPERATIONS = {
  ...SESSION_OPERATIONS,
  ...AGENT_OPERATIONS,
  ...GOAL_OPERATIONS,
  ...REGISTRY_OPERATIONS,
  ...PERSISTENCE_OPERATIONS,
  ...CHANNEL_OPERATIONS,
  ...TELEGRAM_OPERATIONS,
  ...PONYTAIL_OPERATIONS,
  ...COMMAND_OPERATIONS,
  ...MCP_OPERATIONS,
  ...TOOL_OPERATIONS,
} as const;

export type OperationId = (typeof ALL_OPERATIONS)[keyof typeof ALL_OPERATIONS];