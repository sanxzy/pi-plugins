import Type, { type Static } from "typebox";

/**
 * Parameter schemas for the pi-c2 tools.
 *
 * The `agent` schema describes background-only delegation. `agent_id` targets
 * an existing job for steering or background resume.
 */

export const agentParams = Type.Object({
  description: Type.String({ description: "Short description of the delegated work." }),
  prompt: Type.String({ description: "Instruction to run in the subagent." }),
  subagent_type: Type.String({ description: "Name of the agent definition to run." }),
  agent_id: Type.Optional(Type.String({ description: "Existing job id to steer or resume in background. A running job is steered; a finished job is resumed from its stored transcript." })),
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

const telegramChoiceOption = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 64 }),
  value: Type.String({ minLength: 1, maxLength: 1000 }),
}, { additionalProperties: false });

// Keep the public tool schema as one object. Provider adapters commonly reject
// top-level anyOf/oneOf schemas, even though they are valid JSON Schema. The
// action-specific requirements remain enforced by the executor and adapter.
const telegramMediaSource = Type.Object({
  kind: Type.String({ enum: ["file_id", "artifact_id", "https"] }),
  file_id: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  artifact_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" })),
  url: Type.Optional(Type.String({ minLength: 1, maxLength: 2048, format: "uri" })),
}, { additionalProperties: false });

const telegramReactionEmoji = [
  "👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮",
  "💩", "🙏", "👌", "🥱", "🥴", "😍", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨",
  "😐", "🍓", "🍾", "💋", "😈", "😴", "😭", "🤓", "👻", "👀", "🎃", "🙈", "😇", "😨", "🤝",
  "✍", "🤗", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "😎", "👾", "🤷", "😡",
] as const;

export const telegramChatParams = Type.Object({
  action: Type.String({ enum: ["send_text", "react", "send_choices", "send_media"] }),
  chat_id: telegramChatId,
  text: Type.Optional(Type.String({ description: "The communication or report text to send to Telegram." })),
  format: Type.Optional(Type.String({ enum: ["plain", "html", "markdown_v2"], description: "Presentation format; plain is the default." })),
  message_id: Type.Optional(Type.Integer({ minimum: 1, description: "Reply to or react to this Telegram message." })),
  link_preview_options: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Telegram link-preview overrides, passed only when requested." })),
  disable_notification: Type.Optional(Type.Boolean({ description: "Suppress the notification for this message when explicitly requested." })),
  question: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  choices: Type.Optional(Type.Array(telegramChoiceOption, { minItems: 2, maxItems: 10 })),
  media_type: Type.Optional(Type.String({ enum: ["photo", "document"] })),
  source: Type.Optional(telegramMediaSource),
  caption: Type.Optional(Type.String({ maxLength: 1024 })),
  filename: Type.Optional(Type.String({ maxLength: 255 })),
  emoji: Type.Optional(Type.String({ enum: [...telegramReactionEmoji], description: "A standard Telegram reaction emoji." })),
}, { additionalProperties: false });

export type TelegramChatParams =
  | { action: "send_text"; chat_id: string; text: string; format?: "plain" | "html" | "markdown_v2"; message_id?: number; link_preview_options?: Record<string, unknown>; disable_notification?: boolean; question?: never; choices?: never; media_type?: never; source?: never; caption?: never; filename?: never; emoji?: never }
  | { action: "react"; chat_id: string; message_id: number; emoji: string; text?: never; format?: never; link_preview_options?: never; disable_notification?: never; question?: never; choices?: never; media_type?: never; source?: never; caption?: never; filename?: never }
  | { action: "send_choices"; chat_id: string; question: string; choices: Array<{ label: string; value: string }>; message_id?: number; text?: never; format?: never; link_preview_options?: never; disable_notification?: never; media_type?: never; source?: never; caption?: never; filename?: never; emoji?: never }
  | { action: "send_media"; chat_id: string; media_type: "photo" | "document"; source: { kind: "file_id"; file_id: string } | { kind: "artifact_id"; artifact_id: string } | { kind: "https"; url: string }; caption?: string; filename?: string; text?: never; format?: never; message_id?: never; link_preview_options?: never; disable_notification?: never; question?: never; choices?: never; emoji?: never };

export const goalCreateParams = Type.Object({
  prompt: Type.String({ description: "Exact goal prompt to deliver on each interval.", maxLength: 1_000_000 }),
  interval: Type.Optional(Type.String({ description: "Optional positive duration such as 30s, 10m, 2h, or 1d; defaults to 10m." })),
});

export const goalPauseParams = Type.Object({
  reason: Type.String({ description: "Exact reason the goal is blocked or paused." }),
});

export const goalClearParams = Type.Object({
  isComplete: Type.Boolean({ description: "Whether the goal is complete. False keeps the goal active and returns its current context; true clears it." }),
});

export const goalNoArgsParams = Type.Object({});
export type QuestionParams = Static<typeof questionParams>;
export type AgentParams = Static<typeof agentParams>;
export type CancelParams = Static<typeof cancelParams>;
export type StatusParams = Static<typeof statusParams>;
export type GoalCreateParams = Static<typeof goalCreateParams>;
export type GoalClearParams = Static<typeof goalClearParams>;
export type GoalPauseParams = Static<typeof goalPauseParams>;
