import Type, { type Static } from "typebox";

/**
 * Parameter schemas for the pi-code tools.
 *
 * The `agent` schema mirrors the reference contract
 * `{ description, prompt, subagent_type, background, task_id }`
 * (references/opencode/packages/opencode/src/tool/task.ts), with the resume
 * parameter renamed to `agent_id` to match the tool name.
 */

export const agentParams = Type.Object({
  description: Type.String({ description: "Short description of the delegated work." }),
  prompt: Type.String({ description: "Instruction to run in the subagent." }),
  subagent_type: Type.String({ description: "Name of the agent definition to run." }),
  background: Type.Optional(Type.Boolean({ description: "Run in background and inject the result later (TUI only)." })),
  agent_id: Type.Optional(Type.String({ description: "Existing job id to resume or steer. A running job is steered; a finished job is resumed from its stored transcript." })),
});

export const questionOptionSchema = Type.Object({
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

export const questionParams = Type.Object({
  question: Type.String({ description: "The question to ask the user" }),
  options: Type.Array(questionOptionSchema, { description: "Options for the user to choose from" }),
});

export const cancelParams = Type.Object({
  job_id: Type.String({ description: "Id of the job to cancel." }),
});

export const statusParams = Type.Object({
  job_id: Type.String({ description: "Id of the job to query." }),
});

export const jobsParams = Type.Object({});

export const agentNoArgsParams = Type.Object({});

const telegramChatId = Type.String({
  pattern: "^\\d+$",
  description: "Explicit approved private chat id to target.",
});

const telegramSendTextAction = Type.Object({
  action: Type.Literal("send_text"),
  chat_id: telegramChatId,
  text: Type.String({ description: "The communication or report text to send to Telegram." }),
});

export const telegramChatParams = Type.Union([telegramSendTextAction]);

export const goalCreateParams = Type.Object({
  prompt: Type.String({ description: "Exact goal prompt to deliver on each interval." }),
  interval: Type.Optional(Type.String({ description: "Optional positive duration such as 30s, 10m, 2h, or 1d; defaults to 10m." })),
});

export const goalPauseParams = Type.Object({
  reason: Type.String({ description: "Exact reason the goal is blocked or paused." }),
});

export const goalNoArgsParams = Type.Object({});
export type QuestionParams = Static<typeof questionParams>;
export type AgentParams = Static<typeof agentParams>;
export type CancelParams = Static<typeof cancelParams>;
export type StatusParams = Static<typeof statusParams>;
export type TelegramChatParams = Static<typeof telegramChatParams>;
export type GoalCreateParams = Static<typeof goalCreateParams>;
export type GoalPauseParams = Static<typeof goalPauseParams>;
