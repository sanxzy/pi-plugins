/**
 * Central registry of `processWithLog` operation identifiers.
 *
 * Every meaningful processing boundary in pi-code uses one of these constants
 * as its `operation`. Centralizing them keeps operation names stable and
 * searchable (single source of truth), avoids typos across the many call sites,
 * and makes log rerouting/analysis predictable.
 *
 * Naming convention: `<domain>.<verb>` (lowercase, dot-separated). Domains are
 * the processing-family (session, agent, goal, registry, telegram, command,
 * tool). The `normalizeOperation` fallback in `index.ts` is only a safety net
 * for unknowable dynamic operations, not a substitute for these constants.
 */

export const SESSION_OPERATIONS = {
  START: "session.start",
  STOP: "session.stop",
  BEFORE_SWITCH: "session.beforeSwitch",
  CLEANUP: "session.cleanup",
} as const;

export const AGENT_OPERATIONS = {
  LIFECYCLE: "agent.lifecycle",
  RUN_BACKGROUND: "agent.runBackground",
  STATUS: "agent.status",
  LIST: "agent.list",
  CANCEL: "agent.cancel",
} as const;

export const GOAL_OPERATIONS = {
  CREATE: "goal.create",
  PAUSE: "goal.pause",
  RESUME: "goal.resume",
  CLEAR: "goal.clear",
  TICK: "goal.tick",
  BIND: "goal.bind",
  SHUTDOWN: "goal.shutdown",
  CLEAR_STORE: "goal.clearStore",
  CLEAR_ACTIVE: "goal.clearActive",
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
} as const;

export const TELEGRAM_OPERATIONS = {
  TRANSPORT_START: "telegram.transportStart",
  TRANSPORT_STOP: "telegram.transportStop",
  LIFECYCLE_START: "telegram.lifecycleStart",
  LIFECYCLE_STOP: "telegram.lifecycleStop",
  INBOUND: "telegram.inbound",
  CONTROLS_DISPATCH: "telegram.controlsDispatch",
  SEND: "telegram.send",
} as const;

export const COMMAND_OPERATIONS = {
  GOAL_COMMAND: "command.goal",
  SETUP_CHANNEL: "command.setupChannel",
  CLEAR_CHANNEL: "command.clearChannel",
  CONTROLS: "command.controls",
} as const;

export const TOOL_OPERATIONS = {
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
  LLM_WIKIS_EXECUTE: "tool.llmWikisExecute",
  AGENT_LIST_EXECUTE: "tool.agentListExecute",
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
  ...TELEGRAM_OPERATIONS,
  ...COMMAND_OPERATIONS,
  ...TOOL_OPERATIONS,
} as const;

export type OperationId = (typeof ALL_OPERATIONS)[keyof typeof ALL_OPERATIONS];